import type { DB } from "../db/index.js";
import type { Config } from "../config.js";
import { shadowCost } from "../exit/costmodel.js";
import type { ChainKey } from "../chains/index.js";

/**
 * Szabálykereső a már összegyűjtött adaton, időbeli szétválasztással:
 *  1) tokenenként egy árnyékpozíció (adott ablak + kilépési terv) eredménye 1 USD-re vetítve – költségekkel, a pool
 *     likviditásával számolt csúszással. Lezárt pozíciónál a tényleges nettó; nyitottnál az utolsó ellenőrzéskori
 *     áron becsült érték (mintha most eladnánk). Így a még futó pozíciók sem esnek ki (nincs „csak a gyorsan
 *     lezárultak” torzítás), és a vékony pool pillanatnyi kiugrása sem számít nyereségnek.
 *  2) csak legalább `minAgeH` órája nyitott pozíciók (mindegyiknek volt ideje kibontakozni);
 *  3) időrend: első 2/3 TANÍTÓ, utolsó 1/3 ELLENŐRZŐ; sok egyszerű szabály (hatókör × 1–2 feltétel) a tanítón,
 *     a legjobbak az ellenőrzőn, amit a keresés nem látott.
 * A jelöltből új árnyékstratégia lesz; a végső döntést az adja friss adaton.
 */

export interface Sample { at: number; chain: string; launchpad: string; p: Record<string, Record<string, unknown>>; value: number; open: boolean }
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

export interface Stat { n: number; mean: number; win: number; low: number; open: number }
/** Átlagos érték 1 USD-re, nyerő arány, és az átlag óvatos (90%) alsó becslése. */
export function stat(xs: Sample[]): Stat {
  const n = xs.length;
  if (!n) return { n: 0, mean: 0, win: 0, low: -Infinity, open: 0 };
  const mean = xs.reduce((a, s) => a + s.value, 0) / n;
  const sd = n > 1 ? Math.sqrt(xs.reduce((a, s) => a + (s.value - mean) ** 2, 0) / (n - 1)) : Infinity;
  return { n, mean, win: xs.filter((s) => s.value > 0).length / n, low: mean - (1.645 * sd) / Math.sqrt(n), open: xs.filter((s) => s.open).length };
}

export interface RuleResult { scope: string; conds: string[]; train: Stat; test: Stat; baseTest: Stat; holds: boolean; better: boolean }

export function explore(samples: Sample[], opts: { minTrain?: number; minTest?: number; top?: number } = {}): { results: RuleResult[]; splitAt: number | null; scopes: Array<{ scope: string; train: Stat; test: Stat }>; tried: number } {
  const minTrain = opts.minTrain ?? 30, minTest = opts.minTest ?? 15, top = opts.top ?? 20;
  const sorted = [...samples].sort((a, b) => a.at - b.at);
  const cut = Math.floor((sorted.length * 2) / 3);
  const train = sorted.slice(0, cut), test = sorted.slice(cut);
  const scopeNames = ["mind", ...new Set(sorted.map((s) => `${s.chain}/${s.launchpad}`))];
  const inScope = (sc: string) => (s: Sample) => sc === "mind" || `${s.chain}/${s.launchpad}` === sc;
  const trainHits = CONDITIONS.map((c) => train.map(c.test)), testHits = CONDITIONS.map((c) => test.map(c.test));
  const scopes = scopeNames.map((sc) => ({ scope: sc, train: stat(train.filter(inScope(sc))), test: stat(test.filter(inScope(sc))) }));
  const combos: number[][] = [];
  for (let i = 0; i < CONDITIONS.length; i++) { combos.push([i]); for (let j = i + 1; j < CONDITIONS.length; j++) combos.push([i, j]); }
  const cand: Array<{ scope: string; ci: number[]; train: Stat }> = [];
  let tried = 0;
  for (const sc of scopeNames) {
    const scTrain = train.map(inScope(sc));
    for (const ci of combos) {
      tried++;
      const xs = train.filter((_, k) => scTrain[k] && ci.every((c) => trainHits[c]![k]));
      if (xs.length >= minTrain) cand.push({ scope: sc, ci, train: stat(xs) });
    }
  }
  cand.sort((a, b) => b.train.low - a.train.low); // rangsor: az átlag óvatos alsó becslése a tanító részen
  const results: RuleResult[] = [];
  const seen = new Set<string>();
  for (const c of cand) {
    if (results.length >= top) break;
    const scTest = test.map(inScope(c.scope));
    const xs = test.filter((_, k) => scTest[k] && c.ci.every((i) => testHits[i]![k]));
    const st = stat(xs), base = scopes.find((s) => s.scope === c.scope)!;
    // ugyanazt a tokenhalmazt kiválasztó szabályokból csak az elsőt mutatjuk (ne legyen 10 sor ugyanarról)
    const sig = `${c.scope}|${c.train.n}|${c.train.mean.toFixed(4)}|${st.n}|${st.mean.toFixed(4)}`;
    if (seen.has(sig)) continue; seen.add(sig);
    results.push({ scope: c.scope, conds: c.ci.map((i) => CONDITIONS[i]!.name), train: c.train, test: st, baseTest: base.test,
      // better: az ellenőrző részen egyértelműen jobb az alapvonalnál; holds: ráadásul nyereséges is (az alsó becslés > 0)
      better: st.n >= minTest && st.mean > base.test.mean && st.low > base.test.mean,
      holds: st.n >= minTest && st.mean > base.test.mean && st.low > base.test.mean && st.low > 0 });
  }
  return { results, splitAt: test[0]?.at ?? null, scopes, tried };
}

interface PosRow { at: number; closed_at: number | null; net_pnl_usd: number | null; size_usd: number; size_native: number; native_received: number; tokens_remaining: number;
  last_price_native: number | null; gas_usd: number | null; liquidity_at_entry: number | null; chain: string; launchpad: string; p: string }

/** Egy pozíció értéke 1 USD-re: lezártnál a nettó; nyitottnál becslés az utolsó áron (eladási költséggel, likviditással). */
export function positionValue(r: PosRow, costModel: Config["cost_model"]): { value: number; open: boolean } | null {
  if (!(r.size_usd > 0)) return null;
  if (r.closed_at !== null && r.net_pnl_usd !== null) return { value: r.net_pnl_usd / r.size_usd, open: false };
  if (r.last_price_native === null || !(r.size_native > 0)) return null;
  const usdPerNative = r.size_usd / r.size_native;
  const gross = r.tokens_remaining * r.last_price_native;
  const sell = gross > 0 ? shadowCost(r.chain as ChainKey, "sell", gross, { feePct: 1, liquidityNative: r.liquidity_at_entry }, costModel) : { netNative: 0, gasUsd: 0 };
  const usd = (r.native_received + Math.max(0, sell.netNative)) * usdPerNative - r.size_usd - (r.gas_usd ?? 0) - (gross > 0 ? sell.gasUsd : 0);
  return { value: usd / r.size_usd, open: true };
}

/** Minták: tokenenként egy árnyékpozíció az adott ablakban és tervben, legalább minAgeMs óta nyitva. */
export function loadSamples(db: DB, costModel: Config["cost_model"], o: { windowSec: number; plan: string; sinceMs: number; minAgeMs: number; now?: number }): { samples: Sample[]; young: number; unvalued: number } {
  const now = o.now ?? Date.now();
  const rows = db.prepare(`SELECT p.opened_at at, p.closed_at, p.net_pnl_usd, p.size_usd, p.size_native, p.native_received, p.tokens_remaining, p.last_price_native, p.gas_usd,
      p.liquidity_at_entry, p.chain, t.launchpad, s.params_json p
    FROM positions p JOIN tokens t ON t.id = p.token_id JOIN snapshots s ON s.token_id = p.token_id AND s.window_sec = p.window_sec
    WHERE p.exit_plan = ? AND p.window_sec = ? AND p.opened_at > ? AND p.arm NOT IN ('live','day1_test') AND (p.close_reason IS NULL OR p.close_reason NOT LIKE 'invalid%')
    GROUP BY p.token_id`).all(o.plan, o.windowSec, o.sinceMs) as PosRow[];
  const samples: Sample[] = []; let young = 0, unvalued = 0;
  for (const r of rows) {
    if (now - r.at < o.minAgeMs) { young++; continue; }
    const v = positionValue(r, costModel); if (!v) { unvalued++; continue; }
    let p: Sample["p"]; try { p = JSON.parse(r.p); } catch { unvalued++; continue; }
    samples.push({ at: r.at, chain: r.chain, launchpad: r.launchpad, p, value: v.value, open: v.open });
  }
  return { samples, young, unvalued };
}
