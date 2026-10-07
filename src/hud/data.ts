import type { DB } from "../db/index.js";
import type { Config } from "../config.js";
import { armStats, nextState } from "../analysis/watch.js";
import { DECISION_MIN_N } from "../report/index.js";
import { positionValue } from "../analysis/explore.js";
import { activeDays, compoundSim } from "../analysis/standings.js";
import { walletNeed, savedWalletBalance } from "../analysis/wallet.js";
import { currentPositionUsd } from "../decision/risk.js";
import { taxedNet } from "../bnb/tax.js";
import { periods as allPeriods } from "../analysis/periods.js";
import { bootstrapCI } from "../report/index.js";

/**
 * HUD adat-réteg (2026-10-04): a webes áttekintő JSON-jai – ugyanazokból a számításokból, mint a /report és az /allas.
 * Minden érték 1 USD-s árnyékmérésből; az „élesben” értékek az élő belépő méretével (lineárisan) felszorozva.
 */
const V2_ARMS = ["rule_v2", "rule_v2_strict", "rule_v2_nofactory"];
const PREGRAD_ARMS = ["pons_pregrad_50", "pons_pregrad_80"];
const BASE_ARMS = ["rule_v2_strict", "rule_v2", "rule_v2_nofactory", "base_uni_hold", "base_uni_hold_nofactory"];
const RH_ARMS: Array<[string, number | "live"]> = [["rule_v2_strict", "live"], ["pons_pregrad_50", 0], ["pons_pregrad_80", 0], ["grad_at", 0], ["grad_30s", 0], ["grad_15_all", 0]];
// a pons_flip95 a saját („flip”) tervével számít – külön sorban (lásd hudSummary)
const BASELINES: Array<[string, string, number | "live"]> = [["random_control", "base", "live"], ["base_uni_all", "base", "live"], ["copy_smart", "base", 0], ["pons_all", "robinhood", "live"]];
const LABEL: Record<string, string> = {
  rule_v2: "v2", rule_v2_strict: "v2 strict", rule_v2_nofactory: "v2 nofactory", base_uni_hold: "uni hold", base_uni_hold_nofactory: "hold nofactory",
  pons_pregrad_50: "pregrad 50", pons_pregrad_80: "pregrad 80", pons_flip95: "flip 95", grad_at: "grad at (optimista ár)", grad_30s: "grad +30s", grad_15_all: "grad +15", random_control: "véletlen",
  base_uni_all: "minden Base", copy_smart: "copy smart", pons_all: "minden PONS",
};
const dayKey = (ms: number) => new Date(ms).toLocaleDateString("sv-SE"); // helyi nap, ÉÉÉÉ-HH-NN

/** Legtöbb egyszerre nyitott pozíció (időpontokból söprés) – a tőkeigény becsléséhez. */
export function peakConcurrent(rows: Array<{ o: number; c: number | null }>, now: number): { n: number; at: number | null } {
  const ev: Array<[number, number]> = [];
  for (const r of rows) { ev.push([r.o, 1]); ev.push([r.c ?? now, -1]); }
  ev.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let cur = 0, best = 0, at: number | null = null;
  for (const [t, d] of ev) { cur += d; if (cur > best) { best = cur; at = t; } }
  return { n: best, at };
}

/** Egy kar nyitott pozíciói (a legfrissebb 12) és a valaha volt legtöbb egyidejű nyitott pozíció. */
function armExtra(db: DB, chain: string, arm: string, win: number, plan: string, sinceMs: number, now: number) {
  const open = db.prepare(`SELECT t.symbol s, p.opened_at o, p.entry_price_native e, p.last_price_native l FROM positions p JOIN tokens t ON t.id = p.token_id
    WHERE p.chain = ? AND p.arm = ? AND p.window_sec = ? AND p.exit_plan = ? AND p.closed_at IS NULL AND p.opened_at > ? ORDER BY p.opened_at DESC LIMIT 12`).all(chain, arm, win, plan, sinceMs) as Array<{ s: string | null; o: number; e: number; l: number | null }>;
  const all = db.prepare(`SELECT opened_at o, closed_at c FROM positions WHERE chain = ? AND arm = ? AND window_sec = ? AND exit_plan = ? AND opened_at > ? AND (close_reason IS NULL OR close_reason NOT LIKE 'invalid%')`).all(chain, arm, win, plan, sinceMs) as Array<{ o: number; c: number | null }>;
  return { openList: open.map((r) => ({ symbol: r.s ?? "?", x: r.l && r.e ? r.l / r.e : null, ageMin: (now - r.o) / 60_000 })), peak: peakConcurrent(all, now) };
}

/** BNB árnyékkarok (2026-10-07): karonként a fő terv (tp2_sl40) eredménye, a többi terv, nyitott pozíciók, legtöbb egyidejű. */
export function hudBnb(db: DB, sinceMs: number, now = Date.now()) {
  const ARMS: Array<[string, string]> = [["bnb_all60", "minden +60s"], ["bnb_all60_d5", "  ↳ 5 mp késéssel"], ["bnb_all60_d10", "  ↳ 10 mp késéssel"],
    ["bnb_whale", "bálna-vétel"], ["bnb_whale_d5", "  ↳ 5 mp késéssel"], ["bnb_whale_d10", "  ↳ 10 mp késéssel"]];
  const PLANS = ["tp2_sl40", "tp1.5_sl30", "C"];
  let has = false; try { db.prepare("SELECT 1 FROM bnb_shadow_positions LIMIT 1").get(); has = true; } catch { /* nincs tábla */ }
  if (!has) return { arms: [], skips: {} as Record<string, number> };
  const arms = ARMS.map(([arm, label]) => {
    // adóval korrigált (a mért vételi/eladási adóval; ahol nincs mérés, 0 adóval) és adó nélküli eredmény
    // 2026-10-08 (a felhasználóval egyeztetve): a FŐ érték a honeypot-teszten (saját cím, 0,05 gwei, oda-vissza ≥ 0,85) ÁTMENT
    // pozíciók adóval korrigált eredménye – élesben is így szűrünk. A szűretlen (minden jelzés) a buborékban marad.
    // Szimuláció nélküli pozíció (10-07 21:54 UTC előtt) a szűrtbe nem számít.
    const baseArm = arm.replace(/_d(5|10)$/, "");
    const plans = PLANS.map((plan) => {
      const rows = db.prepare(`SELECT p.net_usd v, p.size_usd s, p.txs, p.buy_tax b, p.sell_tax t, p.opened_at o, c.me_lo_stage st, c.me_lo_ratio rt FROM bnb_shadow_positions p
        LEFT JOIN bnb_sim_checks c ON c.pair = p.pair AND c.arm = ? WHERE p.arm = ? AND p.plan = ? AND p.closed_at IS NOT NULL AND p.opened_at > ?`).all(baseArm, arm, plan, sinceMs) as Array<{ v: number; s: number; txs: number; b: number | null; t: number | null; o: number; st: number | null; rt: number | null }>;
      const adjOf = (r: typeof rows[number]) => taxedNet(r.v, r.s, r.txs, 0.006, r.b ?? 0, r.t ?? 0)!;
      const pass = rows.filter((r) => r.st === 5 && (r.rt ?? 0) >= 0.85);
      const rawAll = rows.map(adjOf), adjPass = pass.map(adjOf);
      const sum = adjPass.reduce((a, x) => a + x, 0), sumAll = rawAll.reduce((a, x) => a + x, 0);
      const measured = rows.filter((r) => r.b !== null && r.t !== null).length;
      const taxed = rows.filter((r) => (r.b ?? 0) + (r.t ?? 0) > 0.005).length;
      return { plan, n: pass.length, mean: pass.length ? sum / pass.length : null, sum, rawN: rows.length, rawMean: rows.length ? sumAll / rows.length : null,
        simmed: rows.filter((r) => r.st !== null).length, measured, taxed, first: pass.length ? Math.min(...pass.map((r) => r.o)) : null };
    });
    const main = plans[0]!;
    const openRows = db.prepare(`SELECT token, opened_at o, entry_price e, last_price l FROM bnb_shadow_positions WHERE arm = ? AND plan = ? AND closed_at IS NULL ORDER BY opened_at DESC`).all(arm, PLANS[0]) as Array<{ token: string; o: number; e: number; l: number | null }>;
    const all = db.prepare(`SELECT opened_at o, closed_at c FROM bnb_shadow_positions WHERE arm = ? AND plan = ? AND opened_at > ?`).all(arm, PLANS[0], sinceMs) as Array<{ o: number; c: number | null }>;
    const d = main.first ? activeDays(main.first, now) : 0;
    // vétel+eladás szimuláció (2026-10-08): hány jelzés ment át a saját címről; a szimuláción átment pozíciók eredménye (= a szűrő hatása)
    let sim: { n: number; meOk: number; freshOk: number; filteredN: number; filteredMean: number | null } | null = null;
    try {
      const base = arm.replace(/_d(5|10)$/, "");
      const r = db.prepare("SELECT COUNT(*) n, SUM(me_hi_stage = 5) me, SUM(fresh_stage = 5) fr FROM bnb_sim_checks WHERE arm = ? AND at > ?").get(base, sinceMs) as { n: number; me: number | null; fr: number | null };
      const f = db.prepare(`SELECT p.net_usd v, p.size_usd s, p.txs, p.buy_tax b, p.sell_tax t FROM bnb_shadow_positions p JOIN bnb_sim_checks c ON c.pair = p.pair AND c.arm = ?
        WHERE p.arm = ? AND p.plan = 'tp2_sl40' AND p.closed_at IS NOT NULL AND c.me_hi_stage = 5`).all(base, arm) as Array<{ v: number; s: number; txs: number; b: number | null; t: number | null }>;
      const fv = f.map((x) => taxedNet(x.v, x.s, x.txs, 0.006, x.b ?? 0, x.t ?? 0)!);
      if (r.n) sim = { n: r.n, meOk: r.me ?? 0, freshOk: r.fr ?? 0, filteredN: fv.length, filteredMean: fv.length ? fv.reduce((a, b) => a + b, 0) / fv.length : null };
    } catch { /* nincs tábla */ }
    return { arm, label, chain: "bnb", window: 0, n: main.n, mean: main.mean, sum: main.sum, perDay: d >= 0.25 ? main.sum / d : null, open: openRows.length, sim,
      plans, openList: openRows.slice(0, 12).map((r) => ({ symbol: `${r.token.slice(0, 6)}…${r.token.slice(-4)}`, x: r.l && r.e ? r.l / r.e : null, ageMin: (now - r.o) / 60_000 })), peak: peakConcurrent(all, now) };
  });
  const skips = Object.fromEntries((db.prepare("SELECT reason, count(*) n FROM bnb_shadow_skips WHERE at > ? GROUP BY reason").all(sinceMs) as Array<{ reason: string; n: number }>).map((r) => [r.reason, r.n]));
  return { arms, skips };
}

/** Élő BNB láb (2026-10-08): állapot, nyitott pozíciók, lezártak, visszaforgatás, tárca – a HUD tetejére. */
export function hudBnbLive(db: DB, cfg: Config, now = Date.now()) {
  let ok = true; try { db.prepare("SELECT 1 FROM bnb_live_positions LIMIT 1").get(); } catch { ok = false; }
  const L = cfg.bnb_live;
  if (!ok) return { enabled: L.enabled, mode: L.mode, arm: L.arm, positionUsd: L.position_usd, maxOpen: L.max_open, walletBnb: null, walletUsd: null, compound: null, closed: { n: 0, sum: 0, today: 0, wins: 0, avgLatencyMs: null }, open: [], recent: [], shadow: null };
  const meta = (k: string) => { const r = db.prepare("SELECT value FROM meta WHERE key = ?").get(k) as { value: string } | undefined; const v = Number(r?.value); return Number.isFinite(v) ? v : null; };
  const bnbUsd = meta("bnb_usd"), walletBnb = meta("bnb_wallet_bnb");
  const comp = db.prepare("SELECT initial_capital_usd, capital_usd, reserve_usd, position_usd FROM bnb_compound_state WHERE id = 1").get() as { initial_capital_usd: number; capital_usd: number; reserve_usd: number; position_usd: number } | undefined;
  const closedRows = db.prepare("SELECT net_usd v, closed_at c, opened_at o FROM bnb_live_positions WHERE closed_at IS NOT NULL AND arm <> 'fustproba'").all() as Array<{ v: number; c: number; o: number }>;
  const today = dayKey(now);
  const lat = db.prepare("SELECT AVG(latency_ms) a FROM bnb_live_fills WHERE kind = 'buy' AND status = 'success' AND position_id IN (SELECT id FROM bnb_live_positions WHERE arm <> 'fustproba')").get() as { a: number | null };
  const open = (db.prepare("SELECT token, arm, opened_at, spent_usd, entry_price, last_price, peak_price, phase FROM bnb_live_positions WHERE closed_at IS NULL ORDER BY opened_at DESC").all() as Array<{ token: string; arm: string; opened_at: number; spent_usd: number; entry_price: number; last_price: number | null; peak_price: number | null; phase: string }>)
    .map((r) => ({ symbol: `${r.token.slice(0, 6)}…${r.token.slice(-4)}`, address: r.token, chain: "bnb", arms: [r.arm === "bnb_whale" ? "bálna" : "minden +60s"], openedAt: r.opened_at, ageMin: (now - r.opened_at) / 60_000, spentUsd: r.spent_usd,
      nowX: r.last_price ? r.last_price / r.entry_price : null, peakX: r.peak_price ? r.peak_price / r.entry_price : null, phase: r.phase, value: r.last_price ? (r.last_price / r.entry_price - 1) * r.spent_usd : null }));
  const recent = (db.prepare("SELECT token, close_reason r, net_usd v, closed_at c, spent_usd s FROM bnb_live_positions WHERE closed_at IS NOT NULL AND arm <> 'fustproba' ORDER BY closed_at DESC LIMIT 10").all() as Array<{ token: string; r: string; v: number; c: number; s: number }>)
    .map((r) => ({ symbol: `${r.token.slice(0, 6)}…${r.token.slice(-4)}`, reason: r.r, net: r.v, closedAt: r.c, spentUsd: r.s }));
  const sh = db.prepare("SELECT COUNT(*) n, AVG(net_usd) m FROM bnb_shadow_positions WHERE arm = ? AND plan = 'tp2_sl40' AND closed_at IS NOT NULL AND opened_at > ?").get(L.arm, (closedRows[0] ? Math.min(...closedRows.map((r) => r.o)) : now) - 1) as { n: number; m: number | null };
  return {
    enabled: L.enabled, mode: L.mode, arm: L.arm, positionUsd: comp?.position_usd ?? L.position_usd, maxOpen: L.max_open,
    walletBnb, walletUsd: walletBnb !== null && bnbUsd ? walletBnb * bnbUsd : null,
    compound: comp ? { initial: comp.initial_capital_usd, capital: comp.capital_usd, reserve: comp.reserve_usd, position: comp.position_usd, time: `${cfg.compound.recalc_time_local} ${cfg.compound.recalc_timezone}` } : null,
    closed: { n: closedRows.length, sum: closedRows.reduce((a, r) => a + r.v, 0), today: closedRows.filter((r) => dayKey(r.c) === today).reduce((a, r) => a + r.v, 0), wins: closedRows.filter((r) => r.v > 0).length, avgLatencyMs: lat.a },
    open, recent, shadow: sh.n ? { n: sh.n, mean: sh.m } : null,
  };
}

export function hudSummary(db: DB, cfg: Config, sinceMs: number, now = Date.now()) {
  const w = cfg.evaluation.live_window_sec, live = cfg.live_entry.arm, plan = cfg.live_entry.exit_plan, liveSize = currentPositionUsd(db, cfg);
  const closed = db.prepare(`SELECT chain, arm, window_sec w, opened_at o, closed_at c, net_pnl_usd v FROM positions
    WHERE exit_plan = 'live' AND opened_at > ? AND closed_at IS NOT NULL AND close_reason NOT LIKE 'invalid%' AND arm NOT IN ('live','day1_test')`).all(sinceMs) as Array<{ chain: string; arm: string; w: number; o: number; c: number; v: number }>;
  const group = (chain: string, arm: string, win: number) => closed.filter((r) => r.chain === chain && r.arm === arm && r.w === win);
  const armRow = (chain: string, arm: string, win: number) => {
    const rs = group(chain, arm, win), x = armExtra(db, chain, arm, win, "live", sinceMs, now);
    if (!rs.length) return { arm, label: LABEL[arm] ?? arm, chain, window: win, n: 0, mean: null, sum: 0, perDay: null, open: openCount(chain, arm, win), ...x };
    const sum = rs.reduce((a, r) => a + r.v, 0), first = Math.min(...rs.map((r) => r.o)), d = activeDays(first, now);
    return { arm, label: LABEL[arm] ?? arm, chain, window: win, n: rs.length, mean: sum / rs.length, sum, perDay: d >= 0.25 ? sum / d : null, open: openCount(chain, arm, win), ...x };
  };
  const openCount = (chain: string, arm: string, win: number) => (db.prepare("SELECT count(*) n FROM positions WHERE chain = ? AND arm = ? AND window_sec = ? AND exit_plan = 'live' AND closed_at IS NULL AND opened_at > ?").get(chain, arm, win, sinceMs) as { n: number }).n;

  // élő kar: Base-eredmény napra bontva + nyitott pozíciók becsült értéke
  const liveBase = group("base", live, w);
  const days = new Map<string, { sum: number; n: number }>();
  for (const r of liveBase) { const k = dayKey(r.c); const e = days.get(k) ?? { sum: 0, n: 0 }; e.sum += r.v; e.n++; days.set(k, e); }
  const perDay = [...days].sort((a, b) => a[0].localeCompare(b[0])).slice(-14).map(([day, e]) => ({ day, sum: e.sum, n: e.n }));
  const today = dayKey(now), todaySum = days.get(today)?.sum ?? 0;
  const openLive = db.prepare(`SELECT opened_at at, closed_at, net_pnl_usd, size_usd, size_native, native_received, tokens_remaining, last_price_native, gas_usd, liquidity_at_entry, chain, '' launchpad, '' p
    FROM positions WHERE chain = 'base' AND arm = ? AND window_sec = ? AND exit_plan = ? AND closed_at IS NULL AND opened_at > ?`).all(live, w, plan, sinceMs) as Parameters<typeof positionValue>[0][];
  const unreal = openLive.reduce((a, r) => a + (positionValue(r, cfg.cost_model)?.value ?? 0), 0);
  const realized = liveBase.reduce((a, r) => a + r.v, 0);

  const stats = new Map(armStats(db, sinceMs).map((s) => [s.key, s]));
  const allLive = stats.get(`${live}|${w}|${plan}`);
  const st = allLive ? nextState("none", allLive) : "none";
  const wn = walletNeed(db, cfg, sinceMs, liveSize, now), bal = savedWalletBalance(db), sim = compoundSim(db, sinceMs, cfg, now);
  const cs = db.prepare("SELECT growth_pool_usd FROM compound_state WHERE id = 1").get() as { growth_pool_usd: number } | undefined;
  const meta = (k: string) => (db.prepare("SELECT value FROM meta WHERE key = ?").get(k) as { value: string } | undefined)?.value ?? null;
  const cnt = (sql: string) => { try { return (db.prepare(sql).get() as { n: number }).n; } catch { return null; } };

  return {
    now, since: sinceMs, mode: cfg.mode,
    live: { arm: live, label: LABEL[live] ?? live, window: w, plan, chains: cfg.live_entry.chains, sizeUsd: liveSize, shadowSizeUsd: cfg.evaluation.shadow_size_usd },
    pnl: {
      realized, todayRealized: todaySum, unrealized: unreal, openPositions: openLive.length, n: liveBase.length,
      mean: liveBase.length ? realized / liveBase.length : null,
      perDayRate: liveBase.length ? realized / Math.max(activeDays(Math.min(...liveBase.map((r) => r.o)), now), 1e-9) : null,
      liveScale: liveSize, perDay,
    },
    decision: { nAll: allLive?.n ?? 0, nBase: liveBase.length, need: DECISION_MIN_N, ciLow: allLive?.ci?.[0] ?? null, ciHigh: allLive?.ci?.[1] ?? null, state: st },
    random: armRow("base", "random_control", w),
    base: BASE_ARMS.map((a) => armRow("base", a, w)),
    rh: RH_ARMS.map(([a, win]) => armRow("robinhood", a, win === "live" ? w : win)),
    baselines: BASELINES.map(([a, chain, win]) => armRow(chain, a, win === "live" ? w : win)),
    bnb: hudBnb(db, sinceMs, now),
    bnbLive: hudBnbLive(db, cfg, now),
    wallet: { usd: bal?.usd ?? null, at: bal?.at ?? null, needUsd: wn.needUsd, peakOpen: wn.peakOpen, ok: bal ? bal.usd >= wn.needUsd : null },
    compound: { sizeNow: liveSize, poolNow: cs?.growth_pool_usd ?? 0, simSize: sim.size, simPool: sim.pool },
    recorders: {
      sol: { tokens: cnt("SELECT count(*) n FROM sol_tokens"), grads: cnt("SELECT count(*) n FROM sol_grads WHERE kind = 'complete'"), usd: meta("sol_usd") },
      fourmeme: { tokens: cnt("SELECT count(*) n FROM bnb_tokens"), trades: cnt("SELECT count(*) n FROM bnb_trades") },
      pancake: { launches: cnt("SELECT count(*) n FROM bnb_pairs") },
      listings: cnt("SELECT count(*) n FROM listing_events"),
    },
  };
}

/** Nyitott pozíciók a v2 karokban (élő ablak) és a Robinhood pregrad karokban, tokenenként összevonva. */
export function hudPositions(db: DB, cfg: Config, sinceMs: number, now = Date.now()) {
  const w = cfg.evaluation.live_window_sec;
  const rows = db.prepare(`SELECT p.id, p.arm, p.chain, p.token_id, t.symbol, t.address, t.launchpad, p.opened_at, p.entry_price_native, p.last_price_native, p.last_price_at, p.peak_price_native, p.phase, p.stages_done,
      p.size_usd, p.size_native, p.native_received, p.tokens_remaining, p.gas_usd, p.liquidity_at_entry, p.closed_at, p.net_pnl_usd
    FROM positions p JOIN tokens t ON t.id = p.token_id
    WHERE p.exit_plan = 'live' AND p.closed_at IS NULL AND p.opened_at > ? AND p.chain = 'base' AND p.arm IN (${V2_ARMS.map(() => "?").join(",")}) AND p.window_sec = ?
    ORDER BY p.opened_at DESC`).all(sinceMs, ...V2_ARMS, w) as Array<Record<string, unknown> & { token_id: number; arm: string; opened_at: number; entry_price_native: number; last_price_native: number | null; peak_price_native: number | null }>;
  const byTok = new Map<number, Record<string, unknown> & { arms: string[] }>();
  for (const r of rows) {
    const e = byTok.get(r.token_id);
    if (e) { e.arms.push(LABEL[r.arm] ?? r.arm); continue; }
    const v = positionValue({ at: r.opened_at, closed_at: null, net_pnl_usd: null, size_usd: r.size_usd as number, size_native: r.size_native as number, native_received: r.native_received as number, tokens_remaining: r.tokens_remaining as number,
      last_price_native: r.last_price_native, gas_usd: r.gas_usd as number | null, liquidity_at_entry: r.liquidity_at_entry as number | null, chain: r.chain as string, launchpad: "", p: "" }, cfg.cost_model);
    byTok.set(r.token_id, {
      symbol: r.symbol, address: r.address, chain: r.chain, launchpad: r.launchpad, arms: [LABEL[r.arm] ?? r.arm], openedAt: r.opened_at, ageMin: (now - r.opened_at) / 60_000,
      nowX: r.last_price_native ? r.last_price_native / r.entry_price_native : null, peakX: r.peak_price_native ? r.peak_price_native / r.entry_price_native : null,
      phase: r.phase, stages: r.stages_done, value: v?.value ?? null, priceAt: r.last_price_at,
    });
  }
  // 2026-10-07: csak az élesítés-jelölt láncok (Base v2 + BNB fő karok, fő terv); a Robinhood/Solana a karok buborékában látszik
  const out: Array<Record<string, unknown>> = [...byTok.values()];
  let bnbUsd = 0; try { bnbUsd = Number((db.prepare("SELECT value FROM meta WHERE key = 'bnb_usd'").get() as { value: string } | undefined)?.value ?? 0); } catch { /* nincs */ }
  try {
    const b = db.prepare(`SELECT pair, token, arm, opened_at, entry_price, last_price, peak_price, size_usd, size_bnb, tokens_left, received_bnb, txs, phase FROM bnb_shadow_positions
      WHERE closed_at IS NULL AND plan = 'tp2_sl40' AND arm IN ('bnb_all60', 'bnb_whale') ORDER BY opened_at DESC`).all() as Array<{ pair: string; token: string; arm: string; opened_at: number; entry_price: number; last_price: number | null; peak_price: number | null; size_usd: number; size_bnb: number; tokens_left: number; received_bnb: number; txs: number; phase: string }>;
    const byPair = new Map<string, Record<string, unknown> & { arms: string[] }>();
    for (const r of b) {
      const lab = r.arm === "bnb_whale" ? "bálna" : "minden +60s";
      const e = byPair.get(r.pair); if (e) { e.arms.push(lab); continue; }
      const val = bnbUsd > 0 && r.last_price ? (r.received_bnb + r.tokens_left * r.last_price * (1 - 0.0075)) * bnbUsd - r.size_usd - (r.txs + 1) * 0.006 : null;
      byPair.set(r.pair, { symbol: `${r.token.slice(0, 6)}…${r.token.slice(-4)}`, address: r.token, chain: "bnb", launchpad: "pancakeswap", arms: [lab], openedAt: r.opened_at, ageMin: (now - r.opened_at) / 60_000,
        nowX: r.last_price ? r.last_price / r.entry_price : null, peakX: r.peak_price ? r.peak_price / r.entry_price : null, phase: r.phase, stages: 0, value: val === null ? null : val / r.size_usd, priceAt: null });
    }
    out.push(...byPair.values());
  } catch { /* nincs BNB-tábla */ }
  return out;
}

/** Kötésfolyam: belépések és (rész)eladások a v2 / pregrad karokban, időrendben visszafelé, tokenenként összevonva. */
export function hudFeed(db: DB, cfg: Config, sinceMs: number, limit = 40) {
  const w = cfg.evaluation.live_window_sec;
  const armSql = `((p.arm IN (${V2_ARMS.map(() => "?").join(",")}) AND p.window_sec = ?) OR p.arm IN (${PREGRAD_ARMS.map(() => "?").join(",")}))`;
  const args = [...V2_ARMS, w, ...PREGRAD_ARMS];
  const opens = db.prepare(`SELECT 'open' kind, p.opened_at at, p.token_id, t.symbol, p.chain, group_concat(DISTINCT p.arm) arms, NULL reason, NULL x, NULL pnl
    FROM positions p JOIN tokens t ON t.id = p.token_id WHERE p.exit_plan = 'live' AND p.opened_at > ? AND ${armSql} AND (p.close_reason IS NULL OR p.close_reason NOT LIKE 'invalid%')
    GROUP BY p.token_id ORDER BY at DESC LIMIT ?`).all(sinceMs, ...args, limit) as Array<Record<string, unknown>>;
  const sells = db.prepare(`SELECT CASE WHEN p.closed_at IS NOT NULL AND abs(f.at - p.closed_at) < 2000 THEN 'close' ELSE 'sell' END kind, max(f.at) at, p.token_id, t.symbol, p.chain, group_concat(DISTINCT p.arm) arms,
      max(CASE WHEN abs(f.at - p.closed_at) < 2000 THEN p.close_reason END) reason, max(f.real_price_native / p.entry_price_native) x, avg(CASE WHEN abs(f.at - p.closed_at) < 2000 THEN p.net_pnl_usd END) pnl
    FROM fills f JOIN positions p ON p.id = f.position_id JOIN tokens t ON t.id = p.token_id
    WHERE f.kind = 'sell' AND p.exit_plan = 'live' AND p.opened_at > ? AND ${armSql} AND (p.close_reason IS NULL OR p.close_reason NOT LIKE 'invalid%')
    GROUP BY p.token_id, f.at / 60000 ORDER BY at DESC LIMIT ?`).all(sinceMs, ...args, limit) as Array<Record<string, unknown>>;
  const name = (s: unknown) => String(s ?? "").split(",").map((a) => LABEL[a] ?? a).join(", ");
  return [...opens, ...sells].map((e) => ({ ...e, arms: name(e.arms) }) as Record<string, unknown>).sort((a, b) => Number(b.at) - Number(a.at)).slice(0, limit);
}

/**
 * Nagy nyerők (2026-10-04): a v2 karok (élő ablak) és a Robinhood pregrad karok lezárt pozíciói tokenenként (a karok közül a legjobb
 * eredmény), nettó szerint csökkenő sorrendben; és hogy az élő kar Base-nyereségéből mennyit adott a legjobb 5 token.
 */
export function hudWinners(db: DB, cfg: Config, sinceMs: number, limit = 15) {
  const w = cfg.evaluation.live_window_sec, live = cfg.live_entry.arm;
  const rows = db.prepare(`SELECT p.token_id, t.symbol, t.address, p.chain, p.arm, p.net_pnl_usd v, p.peak_price_native / p.entry_price_native peak_x, p.opened_at, p.closed_at, p.close_reason
    FROM positions p JOIN tokens t ON t.id = p.token_id
    WHERE p.exit_plan = 'live' AND p.closed_at IS NOT NULL AND p.opened_at > ? AND p.close_reason NOT LIKE 'invalid%'
      AND ((p.arm IN (${V2_ARMS.map(() => "?").join(",")}) AND p.window_sec = ?) OR p.arm IN (${PREGRAD_ARMS.map(() => "?").join(",")}))`).all(sinceMs, ...V2_ARMS, w, ...PREGRAD_ARMS) as Array<{ token_id: number; symbol: string; address: string; chain: string; arm: string; v: number; peak_x: number; opened_at: number; closed_at: number; close_reason: string }>;
  const by = new Map<number, { symbol: string; address: string; chain: string; arms: string[]; pnl: number; peakX: number; openedAt: number; closedAt: number; reason: string; holdMin: number }>();
  for (const r of rows) {
    const e = by.get(r.token_id);
    if (!e) by.set(r.token_id, { symbol: r.symbol, address: r.address, chain: r.chain, arms: [LABEL[r.arm] ?? r.arm], pnl: r.v, peakX: r.peak_x, openedAt: r.opened_at, closedAt: r.closed_at, reason: r.close_reason, holdMin: (r.closed_at - r.opened_at) / 60_000 });
    else { e.arms.push(LABEL[r.arm] ?? r.arm); if (r.v > e.pnl) Object.assign(e, { pnl: r.v, peakX: r.peak_x, closedAt: r.closed_at, reason: r.close_reason, holdMin: (r.closed_at - r.opened_at) / 60_000 }); }
  }
  const list = [...by.values()].filter((x) => x.pnl > 0).sort((a, b) => b.pnl - a.pnl).slice(0, limit);
  // az élő kar Base-nyereségének koncentrációja
  const liveRows = rows.filter((r) => r.arm === live && r.chain === "base").map((r) => r.v).sort((a, b) => b - a);
  const total = liveRows.reduce((a, b) => a + b, 0), top5 = liveRows.slice(0, 5).reduce((a, b) => a + b, 0);
  const wins = liveRows.filter((x) => x > 0).length;
  return { list, live: { n: liveRows.length, total, top5, wins, withoutTop5: total - top5 } };
}

/**
 * Lezárt értékelési időszakok (2026-10-07): a kulcskarok eredménye a NYITÁS szerinti időszakban (a később záruló pozíciók
 * eredménye is ide számít), 90% bootstrap CI-vel. Base: 60 mp / élő terv; Robinhood: a HUD RH-karjai; BNB: fő terv, adóval.
 */
export function hudPeriods(db: DB, cfg: Config, now = Date.now()) {
  const w = cfg.evaluation.live_window_sec;
  const stat = (vals: number[]) => { const n = vals.length, sum = vals.reduce((a, b) => a + b, 0); const ci = n >= 3 ? bootstrapCI(vals) : null; return { n, mean: n ? sum / n : null, sum, ciLow: ci?.[0] ?? null, ciHigh: ci?.[1] ?? null }; };
  const pos = (chain: string, arm: string, win: number, from: number, to: number) => (db.prepare(`SELECT net_pnl_usd v FROM positions WHERE chain = ? AND arm = ? AND window_sec = ? AND exit_plan = 'live'
    AND opened_at >= ? AND opened_at < ? AND closed_at IS NOT NULL AND (close_reason IS NULL OR close_reason NOT LIKE 'invalid%')`).all(chain, arm, win, from, to) as Array<{ v: number }>).map((r) => r.v);
  let bnbOk = true; try { db.prepare("SELECT 1 FROM bnb_shadow_positions LIMIT 1").get(); } catch { bnbOk = false; }
  // BNB: ahol van honeypot-szimuláció, csak az átmentek (élesben is így szűrünk); az 1. időszakban még nem volt → szűretlen
  const bnb = (arm: string, from: number, to: number) => !bnbOk ? [] : (db.prepare(`SELECT p.net_usd v, p.size_usd s, p.txs, p.buy_tax b, p.sell_tax t, c.me_lo_stage st, c.me_lo_ratio rt FROM bnb_shadow_positions p
    LEFT JOIN bnb_sim_checks c ON c.pair = p.pair AND c.arm = ? WHERE p.arm = ? AND p.plan = 'tp2_sl40' AND p.opened_at >= ? AND p.opened_at < ? AND p.closed_at IS NOT NULL`)
    .all(arm.replace(/_d(5|10)$/, ""), arm, from, to) as Array<{ v: number; s: number; txs: number; b: number | null; t: number | null; st: number | null; rt: number | null }>)
    .filter((r) => r.st === null || (r.st === 5 && (r.rt ?? 0) >= 0.85)).map((r) => taxedNet(r.v, r.s, r.txs, 0.006, r.b ?? 0, r.t ?? 0)!);
  return allPeriods(cfg).filter((p) => p.to !== null && p.to <= now).map((p) => {
    const to = p.to!;
    const rows = [
      ...[...BASE_ARMS, "random_control", "base_uni_all"].map((a) => ({ group: "Base", arm: a, label: LABEL[a] ?? a, ...stat(pos("base", a, w, p.from, to)) })),
      ...RH_ARMS.map(([a, win]) => ({ group: "Robinhood", arm: a, label: LABEL[a] ?? a, ...stat(pos("robinhood", a, win === "live" ? w : win, p.from, to)) })),
      ...["bnb_all60", "bnb_all60_d5", "bnb_all60_d10", "bnb_whale", "bnb_whale_d5", "bnb_whale_d10"].map((a) => ({ group: "BNB", arm: a, label: a.replace("bnb_all60", "minden +60s").replace("bnb_whale", "bálna").replace("_d5", " (+5 mp)").replace("_d10", " (+10 mp)"), ...stat(bnb(a, p.from, to)) })),
    ];
    return { name: p.name, from: p.from, to, rows };
  });
}
