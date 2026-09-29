/**
 * Listázási árnyék-kereskedés szimulációja a mintavételezett árfolyamon (DexScreener, USD).
 * Belépés az észleléskori áron; költség: pool-díj 1% irányonként, csúszás a likviditásból (méret / (likviditás/2 + méret)),
 * MEV 0,3%, gas lánconként. A „magasabb kiszállók” tervei a memecoin-tervekhez képest nagyobb célokkal és lazább stoppal.
 */
export interface Sample { at: number; price: number; liq: number | null }
export interface Plan { name: string; stop?: number; tps?: Array<[mult: number, share: number]>; trail?: number; target?: number; holdMs?: number; maxMs: number }

export const LISTING_PLANS: Plan[] = [
  { name: "gyors", target: 1.3, stop: 0.85, maxMs: 4 * 3_600_000 },                                  // mindent 1,3x-nél vagy −15%-nál, legfeljebb 4 óra
  { name: "lepcsos", stop: 0.7, tps: [[1.5, 0.5], [3, 0.3]], trail: 0.3, maxMs: 7 * 86_400_000 },     // 1,5x: 50%, 3x: 30%, maradék a csúcstól −30%
  { name: "nagy", stop: 0.6, tps: [[2, 0.5], [5, 0.3]], trail: 0.4, maxMs: 7 * 86_400_000 },          // 2x: 50%, 5x: 30%, maradék a csúcstól −40%
  { name: "tartas_1h", holdMs: 3_600_000, maxMs: 3_600_000 },
  { name: "tartas_24h", holdMs: 86_400_000, maxMs: 86_400_000 },
];

export interface SimCost { gasBuyUsd: number; gasSellUsd: number; feePct?: number; mevPct?: number }
export interface SimResult { value: number; closed: boolean; reason: string }

// null = ismeretlen → 2%; 0 likviditás eladáskor = semmit nem kapunk (kiürített pool)
const impact = (usd: number, liq: number | null, sell = false) => (liq === null ? 0.02 : liq > 0 ? usd / (liq / 2 + usd) : sell ? 1 : 0.02);

export function simulate(entryAt: number, entryPrice: number, entryLiq: number | null, series: Sample[], plan: Plan, cost: SimCost, sizeUsd = 1): SimResult {
  const fee = (cost.feePct ?? 1) / 100, mev = (cost.mevPct ?? 0.3) / 100;
  let tokens = (sizeUsd * (1 - fee - mev - impact(sizeUsd, entryLiq))) / entryPrice;
  const bought = tokens;
  let cash = -sizeUsd - cost.gasBuyUsd, peak = entryPrice, stage = 0;
  const sell = (share: number, p: number, liq: number | null) => {
    const q = Math.min(tokens, bought * share); if (q <= 0) return;
    const gross = q * p; cash += Math.max(0, gross * (1 - fee - mev - impact(gross, liq, true))) - cost.gasSellUsd; tokens -= q;
  };
  const sellAll = (p: number, liq: number | null) => { if (tokens > 0) { const gross = tokens * p; cash += Math.max(0, gross * (1 - fee - mev - impact(gross, liq, true))) - cost.gasSellUsd; tokens = 0; } };
  for (const s of series) {
    if (s.at <= entryAt) continue;
    const m = s.price / entryPrice, age = s.at - entryAt;
    peak = Math.max(peak, s.price);
    if (plan.holdMs !== undefined && age >= plan.holdMs) { sellAll(s.price, s.liq); return { value: cash / sizeUsd, closed: true, reason: "tartás lejárt" }; }
    if (plan.target !== undefined && m >= plan.target) { sellAll(s.price, s.liq); return { value: cash / sizeUsd, closed: true, reason: `cél ${plan.target}x` }; }
    if (plan.tps) while (stage < plan.tps.length && m >= plan.tps[stage]![0]) { sell(plan.tps[stage]![1], s.price, s.liq); stage++; }
    if (plan.stop !== undefined && stage === 0 && m <= plan.stop) { sellAll(s.price, s.liq); return { value: cash / sizeUsd, closed: true, reason: `stop ${Math.round((1 - plan.stop) * 100)}%` }; }
    if (plan.trail !== undefined && plan.tps && stage >= plan.tps.length && s.price <= peak * (1 - plan.trail)) { sellAll(s.price, s.liq); return { value: cash / sizeUsd, closed: true, reason: "trailing" }; }
    if (tokens <= 1e-18) return { value: cash / sizeUsd, closed: true, reason: "minden eladva" };
    if (age >= plan.maxMs) { sellAll(s.price, s.liq); return { value: cash / sizeUsd, closed: true, reason: "időkorlát" }; }
  }
  // még nyitott: értékelés az utolsó áron (mintha most eladnánk)
  const last = series.filter((s) => s.at > entryAt).at(-1);
  if (last && tokens > 0) { const gross = tokens * last.price; return { value: (cash + Math.max(0, gross * (1 - fee - mev - impact(gross, last.liq, true))) - cost.gasSellUsd) / sizeUsd, closed: false, reason: "nyitott" }; }
  return { value: (cash + tokens * entryPrice) / sizeUsd, closed: false, reason: "nincs adat" };
}
