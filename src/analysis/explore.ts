import type { DB } from "../db/index.js";
import type { Config } from "../config.js";

/**
 * Szabálykereső a már összegyűjtött adaton (pillanatkép + kimenet), időbeli szétválasztással:
 *  1) a tokeneket időrendbe teszi, az első 2/3 a TANÍTÓ, az utolsó 1/3 az ELLENŐRZŐ rész;
 *  2) sok egyszerű szabályt (hatókör × 1–2 feltétel) kiértékel a tanító részen;
 *  3) a legjobbakat az ellenőrző részen nézi meg, amit a keresés nem látott.
 * Csak durva szűrő: a kimenetnek csak az összefoglalóját ismerjük (előbb 2x / előbb −40% / egyik sem), a teljes
 * árfolyamot nem. A jelöltből új árnyékstratégia lesz, a végső döntést az adja friss adaton.
 */

export interface Sample { at: number; chain: string; launchpad: string; p: Record<string, Record<string, unknown>>; outcome: "win" | "loss" | "neither" }
export interface Cond { name: string; test: (s: Sample) => boolean }

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const get = (s: Sample, path: string): unknown => { const [g, k] = path.split("."); return s.p[g!]?.[k!]; };
const ge = (path: string, x: number): Cond => ({ name: `${path} ≥ ${x}`, test: (s) => { const v = num(get(s, path)); return v !== null && v >= x; } });
const lt = (path: string, x: number): Cond => ({ name: `${path} < ${x}`, test: (s) => { const v = num(get(s, path)); return v !== null && v < x; } });
const eq = (path: string, x: unknown): Cond => ({ name: `${path} = ${String(x)}`, test: (s) => get(s, path) === x });

export const CONDITIONS: Cond[] = [
  ge("holders.count", 5), ge("holders.count", 10), ge("holders.count", 20), ge("holders.count", 30), lt("holders.count", 10), lt("holders.count", 30),
  ge("dynamics.buyer_acceleration", 1.2), ge("dynamics.buyer_acceleration", 2),
  lt("buyers.bot_ratio", 0.1), lt("buyers.bot_ratio", 0.3),
  ge("contract.liquidity_usd", 3000), ge("contract.liquidity_usd", 10000), lt("contract.liquidity_usd", 10000),
  eq("creator.prior_tokens", 0), ge("creator.prior_tokens", 1),
  lt("creator.token_share_pct", 1), lt("creator.token_share_pct", 5), ge("creator.token_share_pct", 5),
  eq("creator.sold_any", false),
  ge("dynamics.price_change_pct_since_launch", 0.01), ge("dynamics.price_change_pct_since_launch", 50),
  lt("dynamics.peak_drawdown_pct", 10), lt("dynamics.peak_drawdown_pct", 25),
  lt("holders.top10_pct_ex_creator", 50), ge("holders.top10_pct_ex_creator", 70),
  lt("buyers.largest_buy_pct_of_liquidity", 2), ge("buyers.largest_buy_pct_of_liquidity", 2), lt("buyers.largest_buy_pct_of_liquidity", 5),
  ge("buyers.unique_buyers", 10), ge("buyers.unique_buyers", 30),
  ge("dynamics.buy_sell_ratio", 1), ge("dynamics.buy_sell_ratio", 2),
  eq("meta.copycats_24h", 0), ge("meta.copycats_24h", 3),
  lt("holders.fresh_wallet_ratio_top20", 0.5), ge("holders.fresh_wallet_ratio_top20", 0.5),
  eq("contract.lp_owner", "burned"), eq("contract.lp_owner", "contract"), eq("contract.lp_owner", "creator"), eq("contract.lp_owner", "eoa"),
];

/** Közelítő várható érték 1 USD-re: 2x előbb = +1, −40% előbb = −0,4, egyik sem = −0,1, mínusz az oda-vissza költség. */
export const PAYOFF = { win: 1, loss: -0.4, neither: -0.1 };
export function roundTripCost(chain: string, cfg: Config["cost_model"]): number {
  const c = (cfg as Record<string, { gas_buy_usd: number; gas_sell_usd: number; default_slippage_pct: number; mev_allowance_pct: number }>)[chain];
  if (!c) return 0.1;
  return c.gas_buy_usd + c.gas_sell_usd + 2 * (c.default_slippage_pct + c.mev_allowance_pct + 1) / 100; // +1% pool-díj irányonként
}

export interface Stat { n: number; win: number; loss: number; ev: number }
export function stat(xs: Sample[], cost: (s: Sample) => number): Stat {
  if (!xs.length) return { n: 0, win: 0, loss: 0, ev: 0 };
  let w = 0, l = 0, ev = 0;
  for (const s of xs) { if (s.outcome === "win") w++; else if (s.outcome === "loss") l++; ev += PAYOFF[s.outcome] - cost(s); }
  return { n: xs.length, win: w / xs.length, loss: l / xs.length, ev: ev / xs.length };
}

/** Wilson-féle alsó határ (90%) egy arányra – kis mintán óvatos rangsoroláshoz. */
export function wilsonLow(p: number, n: number, z = 1.645): number {
  if (!n) return 0;
  const d = 1 + (z * z) / n, c = p + (z * z) / (2 * n), m = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return (c - m) / d;
}

export interface RuleResult { scope: string; conds: string[]; train: Stat; test: Stat; baseTrain: Stat; baseTest: Stat; holds: boolean }

export function explore(samples: Sample[], costModel: Config["cost_model"], opts: { minTrain?: number; minTest?: number; top?: number } = {}): { results: RuleResult[]; splitAt: number | null; scopes: Array<{ scope: string; train: Stat; test: Stat }>; tried: number } {
  const minTrain = opts.minTrain ?? 30, minTest = opts.minTest ?? 15, top = opts.top ?? 20;
  const sorted = [...samples].sort((a, b) => a.at - b.at);
  const cut = Math.floor((sorted.length * 2) / 3);
  const train = sorted.slice(0, cut), test = sorted.slice(cut);
  const cost = (s: Sample) => roundTripCost(s.chain, costModel);
  const scopeNames = ["mind", ...new Set(sorted.map((s) => `${s.chain}/${s.launchpad}`))];
  const inScope = (sc: string) => (s: Sample) => sc === "mind" || `${s.chain}/${s.launchpad}` === sc;
  // feltételek előre kiértékelve (gyors)
  const trainHits = CONDITIONS.map((c) => train.map(c.test)), testHits = CONDITIONS.map((c) => test.map(c.test));
  const scopes = scopeNames.map((sc) => ({ scope: sc, train: stat(train.filter(inScope(sc)), cost), test: stat(test.filter(inScope(sc)), cost) }));
  const cand: Array<{ scope: string; ci: number[]; train: Stat; score: number }> = [];
  let tried = 0;
  for (const sc of scopeNames) {
    const scTrain = train.map(inScope(sc));
    const combos: number[][] = [];
    for (let i = 0; i < CONDITIONS.length; i++) { combos.push([i]); for (let j = i + 1; j < CONDITIONS.length; j++) combos.push([i, j]); }
    for (const ci of combos) {
      tried++;
      const xs = train.filter((_, k) => scTrain[k] && ci.every((c) => trainHits[c]![k]));
      if (xs.length < minTrain) continue;
      const st = stat(xs, cost);
      cand.push({ scope: sc, ci, train: st, score: wilsonLow(st.win, st.n) - st.loss * 0.4 });
    }
  }
  cand.sort((a, b) => b.score - a.score);
  const results: RuleResult[] = [];
  for (const c of cand) {
    if (results.length >= top) break;
    const scTest = test.map(inScope(c.scope));
    const xs = test.filter((_, k) => scTest[k] && c.ci.every((i) => testHits[i]![k]));
    const st = stat(xs, cost), base = scopes.find((s) => s.scope === c.scope)!;
    results.push({ scope: c.scope, conds: c.ci.map((i) => CONDITIONS[i]!.name), train: c.train, test: st, baseTrain: base.train, baseTest: base.test,
      // Szigorú: a 2x-arány óvatos (Wilson 90%) alsó becslése is az alapvonal fölött legyen, és az érték is jobb legyen.
      holds: st.n >= minTest && st.ev > base.test.ev && wilsonLow(st.win, st.n) > base.test.win });
  }
  return { results, splitAt: test[0]?.at ?? null, scopes, tried };
}

/** Minták a DB-ből: az adott ablak pillanatképe + ugyanannak az ablaknak a kimenete; csak lezárt (van találat vagy letelt a 24 óra). */
export function loadSamples(db: DB, windowSec: number, sinceMs: number): { samples: Sample[]; pending: number } {
  const rows = db.prepare(`SELECT s.params_json p, o.first_hit h, o.done_at d, o.ref_at at, t.chain, t.launchpad FROM token_outcomes o
    JOIN snapshots s ON s.token_id = o.token_id AND s.window_sec = o.window_sec JOIN tokens t ON t.id = o.token_id
    WHERE o.window_sec = ? AND o.ref_at > ?`).all(windowSec, sinceMs) as Array<{ p: string; h: string | null; d: number | null; at: number; chain: string; launchpad: string }>;
  const samples: Sample[] = []; let pending = 0;
  for (const r of rows) {
    if (!r.h && !r.d) { pending++; continue; }
    let p: Sample["p"]; try { p = JSON.parse(r.p); } catch { continue; }
    samples.push({ at: r.at, chain: r.chain, launchpad: r.launchpad, p, outcome: r.h === "tp1_first" ? "win" : r.h === "stop_first" ? "loss" : "neither" });
  }
  return { samples, pending };
}
