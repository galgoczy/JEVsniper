import { test } from "node:test";
import assert from "node:assert/strict";
import { hardFilters } from "../src/filters/hard.js";
import { loadConfig } from "../src/config.js";
import type { ParamSnapshot } from "../src/collector/types.js";

const cfg = loadConfig("config.yaml").hard_filters;

/** Egy "rendes" PONS-token pillanatképe; a tesztek ezt rontják el egy-egy ponton. */
function good(): ParamSnapshot {
  return {
    meta_snapshot: { chain: "robinhood", token: "0x1", window_sec: 60, taken_at: 0, block: 1, elapsed_sec: 60, eth_usd: 4000 },
    contract: { launchpad: "pons", mechanics: "bonding_curve", known_template: true, bytecode_hash: "0xabc", dangerous_rights: [], renounced: true,
      sell_simulation: "ok", buy_tax_pct: 1, sell_tax_pct: 1, liquidity_locked: true, lp_owner: "unknown", liquidity_native: 2, liquidity_usd: 8000,
      market_cap_usd: 20000, total_supply: 1e9, decimals: 18, bonding_curve_progress_pct: 20, graduated: false },
    creator: { address: "0xc", prior_tokens: 0, prior_tokens_24h: 0, prior_graduated: 0, wallet_tx_count: 50, wallet_balance_eth: 0.5,
      token_share_pct: 2, token_balance: "unknown", sold_any: false, sold_pct_of_initial: 0, status: "unknown" },
    holders: { count: 40, growth_per_min: 40, top1_pct_ex_creator: 8, top10_pct_ex_creator: 35, fresh_wallet_ratio_top20: 0.2,
      funding_clusters_top20: 1, airdrop_received_ratio: 0.05, transfers_from_creator: 0 },
    buyers: { smart_money_count: 1, known_scammer_count: 0, bot_ratio: 0.1, avg_buy_native: 0.02, median_buy_native: 0.01,
      largest_buy_pct_of_liquidity: 5, holders_ratio: 0.9, unique_buyers: 35, returning_buyers: 3 },
    dynamics: { buys: 45, sells: 5, buy_volume_native: 1.5, sell_volume_native: 0.1, buys_per_min: 45, sells_per_min: 5, buy_sell_ratio: 9,
      net_inflow_native: 1.4, unique_buyers_per_min: 35, buyer_acceleration: 1.5, price_native: 1e-8, price_change_pct_since_launch: 80,
      peak_drawdown_pct: 5, volatility_pct: 3, large_sells: 0, est_graduation_min: "unknown" },
    meta: { name: "Good", symbol: "GOOD", copycats_24h: 0, trending_tickers_1h: [], has_logo: "unknown", stock_themed: false },
    social: { telegram: "unknown", x: "unknown", website: "unknown", members: "unknown", paid_boost: "unknown" },
    launchpad_ctx: { launches_24h: 100, graduated_24h: 10, graduation_rate_24h: 0.1, launches_1h: 5, alive_1h: "unknown", token_rank_1h: "unknown" },
    timing: { hour_utc: 12, weekend: false, gas_price_gwei: 0.01, block_lag_sec: 1 },
  };
}

test("rendes token átmegy", () => { assert.deepEqual(hardFilters(good(), cfg), { pass: true, reasons: [] }); });

test("honeypot: eladás-szimuláció sikertelen → kiesik", () => {
  const s = good(); s.contract.sell_simulation = "failed";
  const r = hardFilters(s, cfg); assert.equal(r.pass, false); assert.ok(r.reasons.includes("sell_simulation_failed"));
});

test("eladási adó > 5% → kiesik; 5% még átmegy", () => {
  const s = good(); s.contract.sell_tax_pct = 12;
  assert.equal(hardFilters(s, cfg).pass, false);
  s.contract.sell_tax_pct = 5; assert.equal(hardFilters(s, cfg).pass, true);
});

test("nem ismert sablon ÉS veszélyes jogok → kiesik; ismert sablon jogokkal átmegy", () => {
  const s = good(); s.contract.known_template = false; s.contract.dangerous_rights = ["mint(address,uint256)"];
  assert.equal(hardFilters(s, cfg).pass, false);
  s.contract.known_template = true; assert.equal(hardFilters(s, cfg).pass, true);
  s.contract.known_template = "unknown"; assert.equal(hardFilters(s, cfg).pass, false);
});

test("airdrop-spam és bundle (funding-klaszter) → kiesik", () => {
  const a = good(); a.holders.airdrop_received_ratio = 0.7; assert.ok(hardFilters(a, cfg).reasons[0]!.startsWith("airdrop_spam"));
  const b = good(); b.holders.funding_clusters_top20 = 9; assert.ok(hardFilters(b, cfg).reasons[0]!.startsWith("funding_clusters"));
});

test("likviditás nincs lockolva vagy minimum alatt, scammer creator, scammer-walletek", () => {
  const a = good(); a.contract.liquidity_locked = false; assert.equal(hardFilters(a, cfg).pass, false);
  const b = good(); b.contract.liquidity_usd = 100; assert.equal(hardFilters(b, cfg).pass, false);
  const c = good(); c.creator.status = "known_scammer"; assert.equal(hardFilters(c, cfg).pass, false);
  const d = good(); d.buyers.known_scammer_count = 2; assert.equal(hardFilters(d, cfg).pass, false);
});

test("unknown értékek nem ejtenek ki", () => {
  const s = good();
  s.contract.sell_simulation = "unknown"; s.contract.liquidity_usd = "unknown"; s.contract.liquidity_locked = "unknown";
  s.holders.airdrop_received_ratio = "unknown"; s.holders.funding_clusters_top20 = "unknown"; s.contract.sell_tax_pct = "unknown";
  assert.equal(hardFilters(s, cfg).pass, true);
});
