import { getAddress, parseEther } from "viem";
import type { DB } from "../db/index.js";
import { nowMs, todayUtc } from "../db/index.js";
import type { Config } from "../config.js";
import type { ChainKey } from "../chains/index.js";
import type { Executor } from "../exec/executor.js";
import { routeFor } from "../exec/routes.js";
import { JevClient } from "../jev/client.js";
import { holdQuestions } from "../jev/questions.js";
import { PriceFeed, type Tracked } from "./pricefeed.js";
import { planAction, emergencyReason, checkIntervalSec, type PosState, type Phase } from "./plans.js";
import { shadowCost } from "./costmodel.js";
import { log } from "../logger.js";

export interface PosRow extends Omit<PosState, "entry_price" | "peak_price"> {
  entry_price_native: number; peak_price_native: number | null;
  id: number; token_id: number; chain: ChainKey; arm: string; window_sec: number; size_usd: number; size_native: number;
  native_received: number; gas_usd: number | null; fees_usd: number | null; jev_cost_usd: number | null; net_pnl_usd: number | null; next_check_at: number | null; closed_at: number | null; close_reason: string | null;
  creator_balance_at_entry: number | null; liquidity_at_entry: number | null;
  // token
  address: string; symbol: string | null; launchpad: string; mechanics: string; pool_address: string | null; pool_key_json: string | null; creator: string | null; pair_token: string | null; graduated_at: number | null;
}

export interface MonitorDeps {
  db: DB; cfg: Config; jev: JevClient; executors: Partial<Record<ChainKey, Executor>>; feeds: Record<ChainKey, PriceFeed>;
  ethUsd: () => Promise<number | "unknown">; regime: () => string; notify: (t: string) => Promise<unknown>;
  onLiveClosed?: (pos: { id: number; net_pnl_usd: number }) => void;
}

/**
 * 7. Tartás-figyelés: adaptív ütemezés pozíciónként; árfeed kötegelve; vészfékek Jev nélkül; tervlépcsők;
 * Jev hold/exit az élő pozíciókra; árnyék-pozíciók szimulált kitöltéssel (költségmodell); 24 órás kimenet-követés.
 */
export class PositionMonitor {
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  constructor(private d: MonitorDeps) {}

  start(tickMs = 15_000) { this.timer = setInterval(() => void this.tick(), tickMs); void this.tick(); }
  stop() { if (this.timer) clearInterval(this.timer); }

  private openRows(): PosRow[] {
    return this.d.db.prepare(`SELECT p.*, t.address, t.symbol, t.launchpad, t.mechanics, t.pool_address, t.pool_key_json, t.creator, t.pair_token, t.graduated_at
      FROM positions p JOIN tokens t ON t.id = p.token_id WHERE p.closed_at IS NULL AND p.phase NOT IN ('closed','unsellable') AND p.arm != 'day1_test'`).all() as PosRow[];
  }

  private trackedFor(chain: ChainKey, rows: PosRow[]): Tracked[] {
    const seen = new Map<number, Tracked>();
    const add = (r: { token_id: number; address: string; mechanics: string; pool_address: string | null; creator: string | null; pair_token: string | null; graduated_at: number | null }) => {
      if (seen.has(r.token_id)) return;
      seen.set(r.token_id, { tokenId: r.token_id, token: getAddress(r.address), mechanics: r.mechanics, pool: r.pool_address, creator: r.creator ? getAddress(r.creator) : null, decimals: 18, pairToken: r.pair_token });
    };
    for (const r of rows) if (r.chain === chain) add(r);
    // 24 órás kimenet-követés: tokenek, ahol valamelyik kar belépett és még nincs lezárva
    const oc = this.d.db.prepare(`SELECT o.token_id, t.address, t.mechanics, t.pool_address, t.creator, t.pair_token, t.graduated_at FROM token_outcomes o JOIN tokens t ON t.id = o.token_id WHERE o.done_at IS NULL AND t.chain = ?`).all(chain) as never[];
    for (const r of oc) add(r);
    return [...seen.values()];
  }

  async tick(): Promise<void> {
    if (this.busy) return; this.busy = true;
    try {
      const rows = this.openRows();
      const now = nowMs();
      for (const chain of ["base", "robinhood"] as ChainKey[]) {
        if (!this.d.cfg.chains[chain].enabled) continue;
        const due = rows.some((r) => r.chain === chain && (r.next_check_at ?? 0) <= now);
        const tracked = this.trackedFor(chain, rows);
        if (!tracked.length || (!due && (this.d.db.prepare("SELECT COUNT(*) n FROM token_outcomes o JOIN tokens t ON t.id=o.token_id WHERE o.done_at IS NULL AND t.chain=?").get(chain) as { n: number }).n === 0)) continue;
        await this.d.feeds[chain].refresh(tracked).catch((e) => log.warn("árfeed hiba", { chain, error: (e as Error).message.slice(0, 120) }));
        this.updateOutcomes(chain);
      }
      for (const r of rows) {
        if ((r.next_check_at ?? 0) > now) continue;
        await this.checkPosition(r).catch((e) => log.warn("pozíció-ellenőrzés hiba", { id: r.id, error: (e as Error).message.slice(0, 160) }));
      }
    } finally { this.busy = false; }
  }

  private updateOutcomes(chain: ChainKey) {
    const rows = this.d.db.prepare("SELECT o.*, t.chain FROM token_outcomes o JOIN tokens t ON t.id = o.token_id WHERE o.done_at IS NULL AND t.chain = ?").all(chain) as Array<{ token_id: number; ref_price: number; ref_at: number; max_multiple: number; min_multiple: number; first_hit: string | null }>;
    const upd = this.d.db.prepare("UPDATE token_outcomes SET max_multiple = ?, min_multiple = ?, first_hit = COALESCE(first_hit, ?), hit_at = COALESCE(hit_at, ?), done_at = ? WHERE token_id = ?");
    const now = nowMs();
    for (const o of rows) {
      const ps = this.d.feeds[chain].get(o.token_id);
      const m = ps && ps.price > 0 ? ps.price / o.ref_price : null;
      const mx = m !== null ? Math.max(o.max_multiple, m) : o.max_multiple, mn = m !== null ? Math.min(o.min_multiple, m) : o.min_multiple;
      let hit: string | null = null;
      if (!o.first_hit && m !== null) { if (m >= this.d.cfg.exit_plan.tp1_multiple) hit = "tp1_first"; else if (m <= 1 - this.d.cfg.emergency.price_drop_pct / 100) hit = "stop_first"; }
      const done = now - o.ref_at >= 86_400_000 ? now : null;
      upd.run(mx, mn, hit, hit ? now : null, done, o.token_id);
    }
  }

  async checkPosition(r: PosRow) {
    const { db, cfg } = this.d;
    const feed = this.d.feeds[r.chain];
    const ps = feed.get(r.token_id);
    const now = nowMs();
    const setNext = (phase: Phase) => db.prepare("UPDATE positions SET next_check_at = ? WHERE id = ?").run(now + checkIntervalSec({ exit_plan: r.exit_plan, phase, entry_price: r.entry_price_native, peak_price: r.peak_price_native ?? r.entry_price_native, tokens_bought: r.tokens_bought, tokens_remaining: r.tokens_remaining, opened_at: r.opened_at, stages_done: r.stages_done }, now, cfg.monitoring) * 1000, r.id);
    if (!ps || ps.price <= 0) { setNext(r.phase); return; }
    const price = ps.price;
    const peak = Math.max(r.peak_price_native ?? r.entry_price_native, price);
    if (peak !== r.peak_price_native) db.prepare("UPDATE positions SET peak_price_native = ? WHERE id = ?").run(peak, r.id);
    const state: PosState = { exit_plan: r.exit_plan, phase: r.phase, entry_price: r.entry_price_native, peak_price: peak, tokens_bought: r.tokens_bought, tokens_remaining: r.tokens_remaining, opened_at: r.opened_at, stages_done: r.stages_done };

    // vészfékek (Jev nélkül)
    const creatorSoldPct = ps.creatorBalance !== null && r.creator_balance_at_entry ? Math.max(0, (1 - ps.creatorBalance / r.creator_balance_at_entry) * 100) : null;
    const liqDrop = ps.liquidityNative !== null && r.liquidity_at_entry ? Math.max(0, (1 - ps.liquidityNative / r.liquidity_at_entry) * 100) : null;
    const emergency = emergencyReason(state, price, { creatorSoldPct, liquidityDropPct: liqDrop, sellSimFailed: false, regime: this.d.regime(), scammerBigSell: false }, cfg.emergency, cfg.regime);
    let action = emergency ? { sellTokens: r.tokens_remaining, reason: `emergency:${emergency}`, phase: "closed" as Phase, closeAll: true } : planAction(state, price, now, cfg.exit_plan);

    // Jev hold/exit csak élő pozíciókra, ha nincs terv-akció
    if (!action && r.arm === "live" && !this.d.jev.paused && !this.d.jev.overDailyBudget) {
      try {
        const hold = await this.d.jev.ask({
          position: { multiple_now: Number((price / r.entry_price_native).toFixed(3)), peak_multiple: Number((peak / r.entry_price_native).toFixed(3)), drawdown_from_peak_pct: Number(((1 - price / peak) * 100).toFixed(1)), minutes_held: Math.round((now - r.opened_at) / 60_000), phase: r.phase },
          recent: { swaps_since_last_check: ps.swapsSinceLast, sells_since_last_check: ps.sellsSinceLast, creator_sold_pct: creatorSoldPct ?? "unknown", liquidity_change_pct: liqDrop !== null ? -liqDrop : "unknown", graduated: ps.graduated },
          token: { chain: r.chain, launchpad: r.launchpad, symbol: r.symbol }, market_regime: this.d.regime(),
        }, holdQuestions, { purpose: "hold", tokenId: r.token_id, priceNative: price });
        db.prepare("UPDATE positions SET jev_cost_usd = COALESCE(jev_cost_usd,0) + ? WHERE id = ?").run(hold.costUsd, r.id);
        if (hold.answers.exit.noul > cfg.exit_plan.jev_exit_min_p) action = { sellTokens: r.tokens_remaining, reason: `jev_exit_${hold.answers.exit.noul.toFixed(2)}_${hold.answers.trade_pattern.choice}`, phase: "closed", closeAll: true };
      } catch (e) { log.debug("Jev hold hiba", { id: r.id, error: (e as Error).message.slice(0, 100) }); }
    }
    if (!action) { setNext(r.phase); return; }
    if (r.arm === "live") await this.executeLive(r, action, price); else this.executeShadow(r, action, price, ps.liquidityNative);
  }

  private async executeLive(r: PosRow, a: { sellTokens: number; reason: string; phase: Phase; closeAll: boolean }, price: number) {
    const { db, cfg } = this.d;
    const ex = this.d.executors[r.chain]; if (!ex) return;
    const token = getAddress(r.address);
    const route = await routeFor(ex.client, r.chain, r);
    const bal = await ex.tokenBalance(token);
    let tokensWei = a.closeAll ? bal : parseEther(a.sellTokens.toFixed(18));
    if (tokensWei > bal) tokensWei = bal;
    const res = await ex.sell(route, token, tokensWei, cfg.execution.max_slippage_pct, { positionId: r.id, panic: a.reason.startsWith("emergency") });
    const now = nowMs();
    if (res.unsellable) {
      // eladás-szimuláció sikertelen → emelkedő csúszással már próbálta (ladder); riasztás és "nem eladható"
      db.prepare("UPDATE positions SET phase = 'unsellable', next_check_at = ? WHERE id = ?").run(now + 5 * 60_000, r.id);
      await this.d.notify(`🚨 NEM ELADHATÓ ${r.chain}/${r.symbol ?? r.address}: ${res.error ?? "minden csúszás-lépcső sikertelen"} – 5 perc múlva újra próbálja`);
      return;
    }
    const gotNative = Number(res.nativeReceived) / 1e18;
    const sold = Number(tokensWei) / 1e18;
    const remaining = Math.max(0, r.tokens_remaining - sold);
    const closed = a.closeAll || remaining <= 0;
    db.prepare(`UPDATE positions SET tokens_remaining = ?, phase = ?, native_received = native_received + ?, gas_usd = COALESCE(gas_usd,0) + ?, stages_done = stages_done + 1, next_check_at = ?, closed_at = ?, close_reason = ? WHERE id = ?`)
      .run(remaining, closed ? "closed" : a.phase, gotNative, res.gasUsd ?? 0, now + 15_000, closed ? now : null, closed ? a.reason : null, r.id);
    if (closed) await this.closeOut(r.id, "live");
    const mult = price / r.entry_price_native;
    await this.d.notify(`${closed ? "🔴 ZÁRVA" : "🟠 RÉSZLEGES ELADÁS"} ${r.chain}/${r.symbol ?? r.address} @${mult.toFixed(2)}x – ${a.reason}\nkapott ${gotNative.toFixed(6)} ETH, csúszás-lépcső ${res.slippagePct}%, gas ${(res.gasUsd ?? 0).toFixed(4)} USD${closed ? `\nnettó: ${(db.prepare("SELECT net_pnl_usd FROM positions WHERE id = ?").get(r.id) as { net_pnl_usd: number }).net_pnl_usd?.toFixed(3)} USD` : ""}`);
  }

  private executeShadow(r: PosRow, a: { sellTokens: number; reason: string; phase: Phase; closeAll: boolean }, price: number, liq: number | null) {
    const { db, cfg } = this.d;
    const sold = Math.min(a.sellTokens, r.tokens_remaining);
    const gross = sold * price;
    const feePct = r.launchpad === "pons" && !r.graduated_at ? 2 : 1; // curve: fee+creator adó ≈ 2%; v4 pool ≈ 1%
    const c = shadowCost(r.chain, "sell", gross, { feePct, liquidityNative: liq }, cfg.cost_model);
    const now = nowMs();
    const remaining = Math.max(0, r.tokens_remaining - sold);
    const closed = a.closeAll || remaining <= 1e-12;
    db.prepare("INSERT INTO fills(position_id, chain, kind, is_live, at, status, real_price_native, real_gas_usd, slippage_pct, fee_usd, amount_in, amount_out) VALUES (?,?,'sell',0,?,'simulated',?,?,?,?,?,?)")
      .run(r.id, r.chain, now, price, c.gasUsd, gross > 0 ? (c.slippageNative / gross) * 100 : 0, null, sold, c.netNative);
    db.prepare(`UPDATE positions SET tokens_remaining = ?, phase = ?, native_received = native_received + ?, gas_usd = COALESCE(gas_usd,0) + ?, stages_done = stages_done + 1, next_check_at = ?, closed_at = ?, close_reason = ? WHERE id = ?`)
      .run(remaining, closed ? "closed" : a.phase, c.netNative, c.gasUsd, now + 15_000, closed ? now : null, closed ? a.reason : null, r.id);
    if (closed) void this.closeOut(r.id, "shadow");
  }

  /** Lezárt pozíció eredménye: bruttó, díjak/gas/Jev, nettó USD; élőnél napi PnL + compound-hook. */
  async closeOut(id: number, kind: "live" | "shadow") {
    const { db } = this.d;
    const p = db.prepare("SELECT * FROM positions WHERE id = ?").get(id) as PosRow & { size_native: number; native_received: number; gas_usd: number | null; jev_cost_usd: number | null };
    const eth = await this.d.ethUsd();
    const ethUsd = typeof eth === "number" ? eth : 0;
    const gross = (p.native_received - p.size_native) * ethUsd;
    const jevShare = kind === "live" ? (p.jev_cost_usd ?? 0) + 0.0002 : 0; // belépési köteg kb. 0,0001–0,0002 USD
    const net = gross - (p.gas_usd ?? 0) - jevShare;
    db.prepare("UPDATE positions SET gross_pnl_usd = ?, jev_cost_usd = ?, net_pnl_usd = ? WHERE id = ?").run(gross, jevShare, net, id);
    if (kind === "live") {
      db.prepare("INSERT INTO daily_state(day, realized_pnl_usd) VALUES (?, ?) ON CONFLICT(day) DO UPDATE SET realized_pnl_usd = realized_pnl_usd + excluded.realized_pnl_usd").run(todayUtc(), net);
      this.d.onLiveClosed?.({ id, net_pnl_usd: net });
    }
  }
}
