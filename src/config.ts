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

/** Élő vételre beköthető karok (a döntési motor árnyékkarjai közül azok, amelyek az élő ablakban is döntenek). */
export const LIVE_ARMS = ["live_rule", "rule_v2", "rule_v2_strict", "rule_v2_nojev", "rule_v2_nofactory", "base_uni_all", "base_uni_hold",
  "base_uni_hold_nofactory", "base_uni_lp_burned", "base_uni_clean", "clanker_all", "pons_all", "rule_score"] as const;
/** Kilépési tervek: ugyanaz a készlet, mint az árnyékpozícióknál (live = config exit_plan). */
export const EXIT_PLANS = ["live", "B", "C", "moon10", "moon30", "trail40", "trail60", "run70"] as const;

export const ConfigSchema = z.object({
  mode: z.enum(["live", "dry_run"]),
  chains: z.object({ base: ChainCfg, robinhood: ChainCfg }),
  risk: z.object({
    base_position_usd: z.number().positive(),
    // felső határ a belépő méretére; null = nincs (2026-10-03: a felhasználó kérésére kikapcsolva, figyeljük)
    max_position_usd: z.number().positive().nullable().default(null),
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
    // Árnyékpozíciók fix mérete (USD) – az élő pozícióméret (risk.base_position_usd, compound) változása nem érinti
    shadow_size_usd: z.number().positive().default(1),
    // Értékelési időszakok (2026-10-07): a döntési szabály második, független időszakához. A pozíció a NYITÁSA szerinti időszakba
    // tartozik. Az „aktuális” időszak a legutolsó, amelyik már elkezdődött; a jelentések és a HUD alapból azt mutatják.
    periods: z.array(z.object({ name: z.string(), from: z.string().datetime(), to: z.string().datetime().optional() })).default([]),
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
  // Élő vétel (2026-10-01): melyik kar dönt az élő ablakban (evaluation.live_window_sec), és milyen kilépési tervvel.
  // live_rule = a régi Jev-címkés szabály (Jev kikapcsolva → sosem lép be); a többi Jev nélkül, a láncon mért adatokból dönt.
  live_entry: z.object({
    arm: z.enum(LIVE_ARMS).default("live_rule"),
    exit_plan: z.enum(EXIT_PLANS).default("live"),
    // Élő vétel csak ezeken a láncokon (2026-10-03: a nyereség csak Base/Uniswap-ról jön; üres = mindegyik)
    chains: z.array(z.enum(["base", "robinhood"])).default([]),
  }).default({ arm: "live_rule", exit_plan: "live", chains: [] }),
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
  // BNB Chain / Four.Meme felvevő (2026-10-04): minden indítás/vétel/eladás/graduáció mentése a későbbi szabályépítéshez; nem kereskedik
  bnb: z.object({ enabled: z.boolean().default(false), poll_ms: z.number().int().min(1000).default(5000), pancake: z.boolean().default(false) }).default({ enabled: false, poll_ms: 5000, pancake: false }),
  // Webes áttekintő (HUD, 2026-10-04): a bot folyamatában futó, csak olvasó webszerver
  hud: z.object({ enabled: z.boolean().default(false), port: z.number().int().min(0).max(65535).default(8787), host: z.string().default("127.0.0.1"),
    // jelszavas belépés (passkey felvétele után kikapcsolható; passkey nélkül nem kapcsol ki); passkey csak ezeken az eredeteken
    password_login: z.boolean().default(true), origins: z.array(z.string()).default(["https://tradehud.zentopia.hu", "http://localhost:8787"]) })
    .default({ enabled: false, port: 8787, host: "127.0.0.1", password_login: true, origins: ["https://tradehud.zentopia.hu", "http://localhost:8787"] }),
  // Solana / Pump.fun felvevő (2026-10-04): websocket-feliratkozás; tokenek, kötések (első 30 perc), pillanatképek, kimenetek – nem kereskedik
  sol: z.object({ enabled: z.boolean().default(false), amm: z.boolean().default(true) }).default({ enabled: false, amm: true }),
  // V2 – graduációs szakasz (PONS curve → v4): árnyék-belépés graduáláskor és +delay_min perccel később
  graduation: z.object({
    enabled: z.boolean().default(true),
    delay_min: z.number().positive().default(15),
  }).default({ enabled: true, delay_min: 15 }),
  // BNB / PancakeSwap ÉLŐ kereskedés (2026-10-07): a BNB árnyékkarok egyikének jelzéseire valódi vétel/eladás BSC-n, ugyanazzal a tárcával.
  // Csak `mode: live` ÉS `bnb_live.enabled: true` mellett küld tranzakciót; dry_run-ban csak „BELÉPNE” jelzés. Élesítésről csak a felhasználó dönt.
  bnb_live: z.object({
    enabled: z.boolean().default(false),
    arm: z.enum(["bnb_whale", "bnb_all60"]).default("bnb_whale"),
    position_usd: z.number().positive().default(1.5),
    max_open: z.number().int().positive().default(4),
    daily_loss_limit_usd: z.number().positive().default(5),
    max_consecutive_failed: z.number().int().positive().default(3),
    buy_slippage_pct: z.number().positive().default(12),      // az indítási pumpa gyors – a minOut ennyivel a jegyzett alatt
    sell_slippage_pct: z.number().positive().default(15),
    panic_slippage_pct: z.number().positive().default(40),
    gas_gwei: z.number().positive().default(0.2),              // BSC: a 0,05 gwei-s alap fölött → előrébb a blokkban (~0,03 USD/tx)
    max_gas_usd_per_tx: z.number().positive().default(0.15),
    gas_reserve_bnb: z.number().positive().default(0.003),     // ennyi BNB mindig maradjon gázra
    min_liq_bnb: z.number().positive().default(3),             // sekély pár: nincs vétel
  }).default({ enabled: false, arm: "bnb_whale", position_usd: 1.5, max_open: 4, daily_loss_limit_usd: 5, max_consecutive_failed: 3, buy_slippage_pct: 12, sell_slippage_pct: 15, panic_slippage_pct: 40, gas_gwei: 0.2, max_gas_usd_per_tx: 0.15, gas_reserve_bnb: 0.003, min_liq_bnb: 3 }),
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
  if (c.risk.max_position_usd !== null && c.risk.max_position_usd < c.risk.base_position_usd) {
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

/** Belépő méret a config felső határával (ha van; null = nincs plafon). */
export const capPositionUsd = (risk: Config["risk"], usd: number): number => (risk.max_position_usd === null ? usd : Math.min(risk.max_position_usd, usd));

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
