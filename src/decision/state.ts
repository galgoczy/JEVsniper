import type { ParamSnapshot } from "../collector/types.js";

/**
 * A Jev-nek átadott tömör állapot. Csak az adott pillanatban elérhető adat, a technikai mezők (bytecode hash,
 * blokk, címek) nélkül; a számok kerekítve, hogy kevesebb tokent fogyasszon és tisztább legyen a kép.
 */
export function jevStateFromSnapshot(s: ParamSnapshot, extra: { regime?: string; prior_labels?: Record<string, unknown> } = {}) {
  const r = (v: unknown, d = 2) => (typeof v === "number" ? Number(v.toFixed(d)) : v);
  const pick = <T extends object>(o: T, keys: (keyof T)[]) => Object.fromEntries(keys.map((k) => [k, r(o[k])]));
  return {
    context: { chain: s.meta_snapshot.chain, launchpad: s.contract.launchpad, mechanics: s.contract.mechanics, seconds_since_launch: s.meta_snapshot.elapsed_sec, eth_usd: r(s.meta_snapshot.eth_usd, 0), market_regime: extra.regime ?? "unknown" },
    contract: pick(s.contract, ["known_template", "dangerous_rights", "renounced", "sell_simulation", "buy_tax_pct", "sell_tax_pct", "liquidity_locked", "liquidity_usd", "market_cap_usd", "bonding_curve_progress_pct", "graduated"]),
    creator: pick(s.creator, ["prior_tokens", "prior_tokens_24h", "prior_graduated", "wallet_tx_count", "wallet_balance_eth", "token_share_pct", "sold_any", "sold_pct_of_initial", "status"]),
    holders: pick(s.holders, ["count", "growth_per_min", "top1_pct_ex_creator", "top10_pct_ex_creator", "fresh_wallet_ratio_top20", "funding_clusters_top20", "airdrop_received_ratio", "transfers_from_creator"]),
    buyers: pick(s.buyers, ["smart_money_count", "known_scammer_count", "bot_ratio", "avg_buy_native", "median_buy_native", "largest_buy_pct_of_liquidity", "holders_ratio", "unique_buyers", "returning_buyers"]),
    trading: pick(s.dynamics, ["buys", "sells", "buy_volume_native", "sell_volume_native", "buys_per_min", "sells_per_min", "buy_sell_ratio", "net_inflow_native", "unique_buyers_per_min", "buyer_acceleration", "price_change_pct_since_launch", "peak_drawdown_pct", "volatility_pct", "large_sells", "est_graduation_min"]),
    meta: pick(s.meta, ["name", "symbol", "copycats_24h", "trending_tickers_1h", "has_logo", "stock_themed"]),
    social: s.social,
    launchpad_context: s.launchpad_ctx,
    timing: pick(s.timing, ["hour_utc", "weekend", "gas_price_gwei"]),
    ...(extra.prior_labels ? { earlier_labels: extra.prior_labels } : {}),
  };
}
