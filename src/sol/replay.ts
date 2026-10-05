import type { Config } from "../config.js";
import { planAction, type PosState } from "../exit/plans.js";

/**
 * Solana / Pump.fun visszajátszás (2026-10-04): egy belépés szimulálása a felvett kötés-ár útvonalon, ugyanazzal a
 * kilépési logikával (planAction) és −40%-os vészfékkel, mint az éles bot. Költségek: Pump-díj irányonként (fee_pct),
 * tranzakciós díj kötésenként (tx_sol), MEV/csúszás-tartalék (mev_pct). A saját árhatás 1 USD-nél a 30+ SOL virtuális
 * tartalék mellett elhanyagolható, ezért nem számoljuk.
 * Az útvonal vége (30 perc, vagy a tokenenkénti 500 kötés, vagy görbe-teljesülés): a maradék az utolsó áron, eladási
 * költséggel értékelve (`open_at_end`).
 */
export interface SolCost { fee_pct: number; mev_pct: number; tx_sol: number }
export const SOL_COST: SolCost = { fee_pct: 1.25, mev_pct: 0.3, tx_sol: 0.0001 };
export interface PricePoint { at: number; price: number }
export interface ReplayResult { net: number; reason: string; openAtEnd: boolean; peakX: number }

export function replayPosition(entryPrice: number, entryAt: number, path: PricePoint[], plan: string, sizeSol: number, cfg: Config, cost: SolCost = SOL_COST): ReplayResult {
  const sideCost = (cost.fee_pct + cost.mev_pct) / 100;
  const tokens = (sizeSol * (1 - sideCost)) / entryPrice;
  let received = 0, txs = 1;
  const st: PosState = { exit_plan: plan, phase: "pre_tp1", entry_price: entryPrice, peak_price: entryPrice, tokens_bought: tokens, tokens_remaining: tokens, opened_at: entryAt, stages_done: 0 };
  let reason = "";
  // gyors „scalp” terv (csak visszajátszás, 2026-10-05): tp<X>_sl<Y> – teljes eladás X-szeresnél vagy Y%-os esésnél
  const scalp = /^tp([\d.]+)_sl(\d+)$/.exec(plan);
  if (scalp) {
    const tp = Number(scalp[1]), sl = Number(scalp[2]) / 100;
    for (const p of path) {
      if (p.at <= entryAt || !(p.price > 0)) continue;
      st.peak_price = Math.max(st.peak_price, p.price);
      if (p.price >= entryPrice * tp || p.price <= entryPrice * (1 - sl)) {
        received += st.tokens_remaining * p.price * (1 - sideCost); st.tokens_remaining = 0; txs++;
        reason = p.price >= entryPrice * tp ? `tp_${tp}x` : `sl_-${Math.round(sl * 100)}%`; break;
      }
    }
  } else
  for (const p of path) {
    if (p.at <= entryAt || !(p.price > 0)) continue;
    st.peak_price = Math.max(st.peak_price, p.price);
    let sell = 0, closeAll = false;
    if (p.price <= entryPrice * (1 - cfg.emergency.price_drop_pct / 100)) { sell = st.tokens_remaining; closeAll = true; reason = `emergency:price_drop_-${cfg.emergency.price_drop_pct}%`; }
    else {
      const a = planAction(st, p.price, p.at, cfg.exit_plan);
      if (a) { sell = Math.min(a.sellTokens, st.tokens_remaining); closeAll = a.closeAll; st.phase = a.phase; reason = a.reason; }
    }
    if (sell > 0) {
      received += sell * p.price * (1 - sideCost); txs++;
      st.tokens_remaining -= sell; st.stages_done++;
      if (closeAll || st.tokens_remaining <= 1e-12) { st.tokens_remaining = 0; break; }
    }
  }
  const last = path.length ? path[path.length - 1]!.price : entryPrice;
  const openAtEnd = st.tokens_remaining > 1e-12;
  if (openAtEnd) { received += st.tokens_remaining * last * (1 - sideCost); txs++; reason = reason ? `${reason}+nyitva` : "nyitva_a_végén"; }
  return { net: (received - sizeSol - txs * cost.tx_sol) / sizeSol, reason, openAtEnd, peakX: st.peak_price / entryPrice };
}

/** Determinisztikus ~20%-os véletlen minta a mint címéből (a random_control megfelelője). */
export function solRandomPick(mint: string, share = 0.2): boolean {
  let h = 2166136261; for (let i = 0; i < mint.length; i++) { h ^= mint.charCodeAt(i); h = Math.imul(h, 16777619); }
  return ((h >>> 0) % 10_000) / 10_000 < share;
}
