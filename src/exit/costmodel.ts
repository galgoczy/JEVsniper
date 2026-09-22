import type { Config } from "../config.js";
import type { ChainKey } from "../chains/index.js";

export interface ShadowFillCost { gasUsd: number; feeNative: number; slippageNative: number; mevNative: number; netNative: number }

/**
 * 8. Árnyékkarok költségmodellje: gas a mért lánconkénti értékből, díj (curve fee+adó vagy pool fee), csúszás
 * AMM-képlettel a tartalékból (PONS) vagy becsült likviditásból (v4: x/(R+x)), MEV-ráhagyás lánconként.
 * A 2 blokk késést a monitor tick-árazása fedi (a következő tick árán töltünk). Heti korrekció: riport (9.).
 */
export function shadowCost(chain: ChainKey, side: "buy" | "sell", grossNative: number, opts: { feePct: number; liquidityNative: number | null }, cfg: Config["cost_model"]): ShadowFillCost {
  const c = cfg[chain];
  const gasUsd = side === "buy" ? c.gas_buy_usd : c.gas_sell_usd;
  const feeNative = grossNative * (opts.feePct / 100);
  const R = opts.liquidityNative && opts.liquidityNative > 0 ? opts.liquidityNative : null;
  const impact = R ? grossNative / (R + grossNative) : c.default_slippage_pct / 100;
  const slippageNative = grossNative * impact;
  const mevNative = grossNative * (c.mev_allowance_pct / 100);
  const netNative = side === "buy" ? grossNative - feeNative - slippageNative - mevNative : grossNative - feeNative - slippageNative - mevNative;
  return { gasUsd, feeNative, slippageNative, mevNative, netNative };
}
