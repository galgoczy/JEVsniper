import { getAddress, parseEther } from "viem";
import type { DB } from "../db/index.js";
import { nowMs, todayUtc } from "../db/index.js";
import type { Config } from "../config.js";
import type { ParamSnapshot } from "../collector/types.js";
import type { TokenRow } from "../collector/index.js";
import type { ChainKey } from "../chains/index.js";
import { JevClient, JevPausedError } from "../jev/client.js";
import { entryQuestions } from "../jev/questions.js";
import { jevStateFromSnapshot } from "./state.js";
import { labelsFrom, liveEntryRule, jevDirectArm, ruleScoreArm, randomControlArm, type Labels, type RuleResult } from "./rules.js";
import { riskBlock, currentPositionUsd } from "./risk.js";
import type { RegimeGate } from "./regime.js";
import type { Executor } from "../exec/executor.js";
import { routeFor } from "../exec/routes.js";
import { log } from "../logger.js";

export interface EngineDeps {
  db: DB; cfg: Config; jev: JevClient; regime: RegimeGate;
  executors: Partial<Record<ChainKey, Executor>>;
  ethUsd: () => Promise<number | "unknown">;
  notify: (text: string) => Promise<unknown>;
}

const SHADOW_EXIT_PLANS = ["live", "B", "C", "moon10", "moon30", "trail40", "trail60"];

/**
 * 6. Döntési motor. Minden pillanatképre (30/60/180 mp), ami átment a kemény szűrőn:
 *  1) Jev kötegelt címkézés (12 kérdés) → jev_calls + decisions
 *  2) árnyékkarok (jev_direct küszöbök, rule_score, random_control) minden ablakban → decisions + árnyék-pozíciók
 *  3) az élő ablakban (60 mp) az élő szabály + kockázati korlátok → valódi vétel
 * A kiesett tokenekre is fut a címkézés (csak naplózás), hogy a szűrő téves kiejtései mérhetők legyenek.
 */
export class DecisionEngine {
  constructor(private d: EngineDeps) {}

  async onSnapshot(t: TokenRow, snap: ParamSnapshot, filterPassed: boolean): Promise<void> {
    const { db, cfg } = this.d;
    const w = snap.meta_snapshot.window_sec;
    const regime = this.d.regime.regime;
    // 1) Jev címkézés
    let labels: Labels | null = null, callId: number | null = null;
    try {
      const prior = db.prepare("SELECT answers_json FROM jev_calls WHERE token_id = ? AND purpose = 'entry' AND ok = 1 AND window_sec < ? ORDER BY window_sec DESC LIMIT 1").get(t.id, w) as { answers_json: string } | undefined;
      const state = jevStateFromSnapshot(snap, { regime, prior_labels: prior ? summarize(JSON.parse(prior.answers_json)) : undefined });
      const r = await this.d.jev.ask(state, entryQuestions, { purpose: "entry", tokenId: t.id, windowSec: w, blockNumber: snap.meta_snapshot.block,
        priceNative: num(snap.dynamics.price_native) ?? undefined, reserveNative: num(snap.contract.liquidity_native) ?? undefined });
      labels = labelsFrom(r.answers); callId = r.callId;
    } catch (e) {
      if (!(e instanceof JevPausedError)) log.warn("Jev címkézés hiba", { token: t.symbol, error: (e as Error).message.slice(0, 120) });
    }
    if (!filterPassed) return; // kiesett token: csak a címkéket naplóztuk (tanuláshoz)

    const price = num(snap.dynamics.price_native);
    const arms: Array<{ arm: string; res: RuleResult }> = [];
    if (labels) {
      for (const thr of [0.3, 0.4, 0.5]) arms.push({ arm: `jev_direct_${thr}`, res: jevDirectArm(labels, thr) });
      arms.push({ arm: "live_rule", res: liveEntryRule(labels, snap, regime, cfg.entry) });
    }
    arms.push({ arm: "rule_score", res: ruleScoreArm(snap) });
    arms.push({ arm: "random_control", res: randomControlArm(t.address, cfg.entry.random_control_share) });

    const posUsd = currentPositionUsd(db, cfg);
    const ins = db.prepare("INSERT INTO decisions(token_id, arm, window_sec, regime, decided_at, enter, reason, size_usd, jev_call_id) VALUES (?,?,?,?,?,?,?,?,?)");
    for (const a of arms) {
      ins.run(t.id, a.arm, w, regime, nowMs(), a.res.enter ? 1 : 0, a.res.reasons.join(","), a.res.enter ? posUsd * a.res.sizeMultiplier : null, callId);
      if (a.res.enter && price !== null) this.openShadow(t, a.arm, w, price, Math.min(cfg.risk.max_position_usd, posUsd * a.res.sizeMultiplier));
    }

    // 3) élő belépés csak az élő ablakban
    if (w !== cfg.evaluation.live_window_sec || !labels) return;
    const live = arms.find((a) => a.arm === "live_rule")!.res;
    if (!live.enter) return;
    const block = riskBlock(db, cfg, t, { jevPaused: this.d.jev.paused, regime, consecutiveFailed: this.d.executors[t.chain]?.consecutiveFailed ?? 0 });
    ins.run(t.id, "live", w, regime, nowMs(), block ? 0 : 1, block ?? "enter", block ? null : posUsd * live.sizeMultiplier, callId);
    if (block) { log.info(`Élő belépés blokkolva: ${block}`, { token: t.symbol }); return; }
    await this.enterLive(t, snap, labels, Math.min(cfg.risk.max_position_usd, posUsd * live.sizeMultiplier), w);
  }

  private openShadow(t: TokenRow, arm: string, w: number, price: number, sizeUsd: number) {
    const ins = this.d.db.prepare(`INSERT OR IGNORE INTO positions(token_id, chain, arm, exit_plan, window_sec, opened_at, entry_price_native, size_usd, size_native, tokens_bought, tokens_remaining, phase, peak_price_native)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,'pre_tp1',?)`);
    for (const plan of SHADOW_EXIT_PLANS) ins.run(t.id, t.chain, arm, plan, w, nowMs(), price, sizeUsd, 0, 0, 0, price);
  }

  private async enterLive(t: TokenRow, snap: ParamSnapshot, labels: Labels, sizeUsd: number, w: number) {
    const { db, cfg } = this.d;
    const ex = this.d.executors[t.chain];
    if (!ex) return;
    const eth = await this.d.ethUsd();
    if (typeof eth !== "number") { log.warn("nincs ETH/USD ár – nincs élő vétel"); return; }
    const wei = parseEther((sizeUsd / eth).toFixed(18));
    const token = getAddress(t.address);
    try {
      const route = await routeFor(ex.client, t.chain, t);
      const posId = Number(db.prepare(`INSERT INTO positions(token_id, chain, arm, exit_plan, window_sec, opened_at, entry_price_native, size_usd, size_native, tokens_bought, tokens_remaining, phase)
        VALUES (?,?,'live','live',?,?,?,?,?,0,0,'pre_tp1')`).run(t.id, t.chain, w, nowMs(), num(snap.dynamics.price_native) ?? 0, sizeUsd, Number(wei) / 1e18).lastInsertRowid);
      const r = await ex.buy(route, token, wei, cfg.execution.max_slippage_pct, { positionId: posId });
      if (!r.ok || r.tokensReceived <= 0n) {
        db.prepare("UPDATE positions SET phase = 'closed', closed_at = ?, close_reason = ?, net_pnl_usd = ? WHERE id = ?").run(nowMs(), `buy_failed:${r.error ?? "no_tokens"}`, -(r.gasUsd ?? 0), posId);
        await this.d.notify(`⚠️ Vétel sikertelen ${t.chain}/${t.symbol ?? t.address}: ${r.error ?? "nem jött token"}`);
        return;
      }
      const tokens = Number(r.tokensReceived) / 1e18;
      const entryPrice = Number(wei) / Number(r.tokensReceived);
      db.prepare("UPDATE positions SET tokens_bought = ?, tokens_remaining = ?, entry_price_native = ?, peak_price_native = ?, gas_usd = ? WHERE id = ?").run(tokens, tokens, entryPrice, entryPrice, r.gasUsd ?? 0, posId);
      db.prepare("INSERT INTO daily_state(day, entries) VALUES (?, 1) ON CONFLICT(day) DO UPDATE SET entries = entries + 1").run(todayUtc());
      db.prepare("UPDATE tokens SET status = 'entered' WHERE id = ?").run(t.id);
      await this.d.notify(`🟢 VÉTEL ${t.chain}/${t.launchpad} ${t.symbol ?? "?"} ${sizeUsd.toFixed(2)} USD\nP(2x előbb)=${labels.p_tp1.toFixed(2)} vevőminőség=${labels.buyer_quality} minta=${labels.trade_pattern} időzítés=${labels.entry_timing}\ngas ${(r.gasUsd ?? 0).toFixed(4)} USD, tx ${r.hash}`);
    } catch (e) {
      log.warn("élő belépés hiba", { token: t.symbol, error: (e as Error).message.slice(0, 160) });
    }
  }
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
function summarize(answers: Record<string, { choice?: string; score?: number; noul?: number }>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(answers).map(([k, v]) => [k, v.choice ?? v.score ?? v.noul]));
}
