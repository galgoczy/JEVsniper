/** Minden mező vagy érték, vagy "unknown" (spec 6.1). */
export type U<T> = T | "unknown";

export interface ParamSnapshot {
  meta_snapshot: { chain: string; token: string; window_sec: number; taken_at: number; block: number; elapsed_sec: number; eth_usd: U<number> };
  contract: {
    launchpad: string; mechanics: string; known_template: U<boolean>; bytecode_hash: string;
    dangerous_rights: U<string[]>; renounced: U<boolean>;
    sell_simulation: U<"ok" | "failed" | "not_supported">; buy_tax_pct: U<number>; sell_tax_pct: U<number>;
    liquidity_locked: U<boolean>; lp_owner: U<"burned" | "creator" | "eoa" | "contract" | "removed" | "none">; liquidity_native: U<number>; liquidity_usd: U<number>;
    market_cap_usd: U<number>; total_supply: U<number>; decimals: U<number>;
    bonding_curve_progress_pct: U<number>; graduated: U<boolean>;
  };
  creator: {
    address: U<string>; prior_tokens: number; prior_tokens_24h: number; prior_graduated: number;
    wallet_tx_count: U<number>; wallet_balance_eth: U<number>;
    token_share_pct: U<number>; token_balance: U<number>; sold_any: U<boolean>; sold_pct_of_initial: U<number>;
    status: "known_good" | "known_scammer" | "unknown";
  };
  holders: {
    count: U<number>; growth_per_min: U<number>;
    top1_pct_ex_creator: U<number>; top10_pct_ex_creator: U<number>;
    fresh_wallet_ratio_top20: U<number>; funding_clusters_top20: U<number>;
    airdrop_received_ratio: U<number>; transfers_from_creator: U<number>;
  };
  buyers: {
    smart_money_count: number; known_scammer_count: number; bot_ratio: U<number>;
    avg_buy_native: U<number>; median_buy_native: U<number>; largest_buy_pct_of_liquidity: U<number>;
    holders_ratio: U<number>; unique_buyers: U<number>; returning_buyers: U<number>;
  };
  dynamics: {
    buys: U<number>; sells: U<number>; buy_volume_native: U<number>; sell_volume_native: U<number>;
    buys_per_min: U<number>; sells_per_min: U<number>; buy_sell_ratio: U<number>; net_inflow_native: U<number>;
    unique_buyers_per_min: U<number>; buyer_acceleration: U<number>;
    price_native: U<number>; price_change_pct_since_launch: U<number>; peak_drawdown_pct: U<number>; volatility_pct: U<number>;
    large_sells: U<number>; est_graduation_min: U<number>;
  };
  meta: {
    name: U<string>; symbol: U<string>; copycats_24h: number; trending_tickers_1h: string[];
    has_logo: U<boolean>; stock_themed: U<boolean>;
  };
  social: { telegram: U<boolean>; x: U<boolean>; website: U<boolean>; members: U<number>; paid_boost: U<boolean> };
  launchpad_ctx: { launches_24h: number; graduated_24h: number; graduation_rate_24h: U<number>; launches_1h: number; alive_1h: U<number>; token_rank_1h: U<number> };
  timing: { hour_utc: number; weekend: boolean; gas_price_gwei: U<number>; block_lag_sec: U<number> };
}
