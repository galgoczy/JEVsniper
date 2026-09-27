import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";

const pct = z.number().min(0).max(100);
const prob = z.number().min(0).max(1);

const ChainCfg = z.object({
  enabled: z.boolean(),
  chain_id: z.number().int().positive(),
  native_symbol: z.string(),
});

const CostCfg = z.object({
  gas_buy_usd: z.number().min(0), gas_sell_usd: z.number().min(0), default_slippage_pct: pct, mev_allowance_pct: pct,
});

const WatcherCfg = z.object({
  poll_interval_ms: z.number().int().min(500),
  max_block_range: z.number().int().min(1).max(2000),
  confirmations: z.number().int().min(0),
  sources: z.record(z.string(), z.boolean()),
});

export const ConfigSchema = z.object({
  mode: z.enum(["live", "dry_run"]),
  chains: z.object({ base: ChainCfg, robinhood: ChainCfg }),
  risk: z.object({
    base_position_usd: z.number().positive(),
    max_position_usd: z.number().positive(),
    deposit_cap_usd: z.number().positive(),
    max_open_positions: z.number().int().positive(),
    max_entries_per_hour: z.number().int().positive(),
    max_entries_per_day: z.number().int().positive(),
    daily_loss_limit_pct_of_working_capital: pct,
    max_consecutive_failed_tx: z.number().int().positive(),
    max_gas_per_tx_usd: z.number().positive(),
    max_gas_per_sell_usd: z.number().positive(),
    jev_daily_budget_usd: z.number().positive(),
    one_entry_per_token: z.boolean(),
    max_entries_per_creator_per_day: z.number().int().positive(),
  }),
  compound: z.object({
    profit_share_to_growth_pool: prob,
    drawdown_halving_pct: pct,
    recalc_time_utc: z.string().regex(/^\d{2}:\d{2}$/),
    require_positive_vs_random_control: z.boolean(),
    random_control_lookback_days: z.number().int().positive(),
  }),
  regime: z.object({
    recalc_minutes: z.number().int().positive(),
    eth_24h_drop_pct_risk_off: pct,
    jev_risk_off_min_p: prob,
    risk_off_close_phases: z.array(z.enum(["pre_tp1", "post_tp1", "moon_bag"])),
  }),
  watcher: z.object({
    base: WatcherCfg,
    robinhood: WatcherCfg,
  }),
  evaluation: z.object({
    windows_sec: z.array(z.number().int().positive()).min(1),
    live_window_sec: z.number().int().positive(),
    jev_scope: z.array(z.string()).default([]),
    // Késői „túlélő” ablak: csak ezekre a "lánc/launchpad" tokenekre, ennyi mp-cel az indulás után (0 = kikapcsolva)
    late_window_sec: z.number().int().min(0).default(0),
    late_scope: z.array(z.string()).default([]),
  }),
  jev: z.object({
    enabled: z.boolean().default(true),
    model: z.string(),
    timeout_ms: z.number().int().positive(),
    max_retries: z.number().int().min(0),
    usd_per_million_input_tokens: z.number().min(0),
    pause_after_consecutive_errors: z.number().int().positive(),
    pause_minutes: z.number().positive(),
  }),
  hard_filters: z.object({
    max_sell_tax_pct: pct,
    min_initial_liquidity_usd: z.number().min(0),
    creator_prior_rug_ratio_max: prob,
    funding_cluster_top20_max: z.number().int().min(0),
    airdrop_received_ratio_max: prob,
    known_scammer_wallets_max: z.number().int().min(0),
  }),
  entry: z.object({
    contract_risk_clean_min_p: prob,
    bad_wallet_pattern_max_p: prob,
    bad_crowd_type_max_p: prob,
    buyer_quality_min: pct,
    tp1_first_min_p: z.object({ hot: prob, normal: prob, cold: prob }),
    size_boost: z.object({
      multiplier: z.number().min(1),
      buyer_quality_min: pct,
      smart_money_min: z.number().int().min(0),
      tp1_first_min_p: prob,
    }),
    random_control_share: prob,
  }),
  exit_plan: z.object({
    tp1_multiple: z.number().min(1),
    tp1_sell_pct: pct,
    tp2_multiple: z.number().min(1),
    tp2_sell_pct: pct,
    moon_bag_pct: pct,
    moon_target_multiple: z.number().min(1),
    trailing_stop_pct: pct,
    trailing_active_after_tp2: z.boolean(),
    moon_bag_max_days: z.number().positive(),
    jev_exit_min_p: prob,
  }),
  emergency: z.object({
    price_drop_pct: pct,
    creator_sell_pct: pct,
    liquidity_drop_pct: pct,
  }),
  monitoring: z.object({
    first_5min_interval_sec: z.number().int().positive(),
    after_5min_interval_sec: z.number().int().positive(),
    after_1h_interval_sec: z.number().int().positive(),
    moon_bag_interval_sec: z.number().int().positive(),
  }),
  execution: z.object({
    max_slippage_pct: pct,
    panic_slippage_pct: pct,
    max_price_impact_pct: pct,
    deadline_sec: z.number().int().positive(),
    retry_failed_tx_once: z.boolean(),
  }),
  cost_model: z.object({
    base: CostCfg,
    robinhood: CostCfg,
  }),
  telegram: z.object({ enabled: z.boolean(), poll_interval_ms: z.number().int().positive() }),
  report: z.object({ daily_time_utc: z.string(), output_dir: z.string() }),
  // Copy trading árnyékteszt (tárcakövetés a friss tokenek körében; csak árnyék-belépés)
  copy: z.object({
    enabled: z.boolean().default(true),
    universe_hours: z.number().positive().default(6),
    poll_interval_ms: z.number().int().positive().default(20_000),
    min_closed_tokens: z.number().int().positive().default(5),
    min_win_rate: z.number().min(0).max(1).default(0.5),
    min_buy_native: z.number().min(0).default(0.005),
    score_refresh_min: z.number().positive().default(10),
  }).default({ enabled: true, universe_hours: 6, poll_interval_ms: 20_000, min_closed_tokens: 5, min_win_rate: 0.5, min_buy_native: 0.005, score_refresh_min: 10 }),
  // Listázás-figyelő (Coinbase: Base tokenek; Robinhood: Robinhood Chain tokenek) – árnyék-belépés + ár-mintavétel
  listing: z.object({
    enabled: z.boolean().default(true),
    poll_interval_sec: z.number().int().positive().default(60),
    coinbase: z.boolean().default(true),
    robinhood: z.boolean().default(true),
    robinhood_chain_match: z.string().default("robinhood"),
    size_usd: z.number().positive().default(1),
    track_days: z.number().positive().default(7),
  }).default({ enabled: true, poll_interval_sec: 60, coinbase: true, robinhood: true, robinhood_chain_match: "robinhood", size_usd: 1, track_days: 7 }),
  // Futás közbeni figyelő: állapotváltás-riasztások (csak jelez, a szabályokon nem változtat)
  alerts: z.object({
    enabled: z.boolean().default(true),
    since: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),     // ettől a naptól (UTC) számol
    features_since: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), // szabálykereső: ettől megbízhatók a pillanatkép-jellemzők
    interval_min: z.number().int().positive().default(60),
    big_winner_multiple: z.number().positive().default(10), // ennyiszeres csúcsnál külön értesítés (60 mp-es ár)
  }).default({ enabled: true, since: "2026-09-27", interval_min: 60, big_winner_multiple: 10 }),
  db: z.object({ path: z.string(), max_snapshot_bytes: z.number().int().positive() }),
}).superRefine((c, ctx) => {
  if (c.risk.max_position_usd < c.risk.base_position_usd) {
    ctx.addIssue({ code: "custom", message: "risk.max_position_usd < base_position_usd" });
  }
  const e = c.exit_plan;
  if (e.tp1_sell_pct + e.tp2_sell_pct + e.moon_bag_pct !== 100) {
    ctx.addIssue({ code: "custom", message: "exit_plan: tp1+tp2+moon_bag sell % must be 100" });
  }
  if (!c.evaluation.windows_sec.includes(c.evaluation.live_window_sec)) {
    ctx.addIssue({ code: "custom", message: "evaluation.live_window_sec must be one of windows_sec" });
  }
});

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(file = process.env.CONFIG_PATH ?? "config.yaml"): Config {
  const abs = path.resolve(file);
  const raw = YAML.parse(fs.readFileSync(abs, "utf8"));
  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const msgs = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Hibás config.yaml (${abs}):\n${msgs}`);
  }
  return parsed.data;
}
