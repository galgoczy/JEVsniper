import type { Config } from "../config.js";

export type Phase = "pre_tp1" | "post_tp1" | "post_tp2" | "moon_bag" | "closed" | "unsellable";
export interface PosState {
  exit_plan: string; phase: Phase; entry_price: number; peak_price: number; tokens_bought: number; tokens_remaining: number;
  opened_at: number; stages_done: number;
}
export interface ExitAction { sellTokens: number; reason: string; phase: Phase; closeAll: boolean }

/**
 * 7.1 Kiszállási tervek – tiszta függvény: (állapot, ár, idő) → mit adjunk el.
 *  live:   2x → 50% (tőke vissza), 5x → 30%, moon bag 20%: 20x VAGY trailing -50% (csak 5x után) VAGY 7 nap
 *  moon10/moon30: mint live, csak a moon-cél 10x/30x;  trail40/trail60: mint live, trailing -40%/-60%
 *  B:      +150/+200/+300/+500% (2,5x/3x/4x/6x) lépcsőknél a vett mennyiség 25%-a, 4 lépcső után zárva
 *  C:      2x-nél 50% (tőke ki), a maradék a csúcstól -35%-nál zár
 * A 7 napos limit és a vészfékek (-40% stb.) minden tervre érvényesek (a monitor kezeli).
 */
export function planAction(p: PosState, price: number, now: number, cfg: Config["exit_plan"]): ExitAction | null {
  if (p.tokens_remaining <= 0 || p.phase === "closed" || p.phase === "unsellable") return null;
  const mult = price / p.entry_price;
  const peak = Math.max(p.peak_price, price);
  const ageDays = (now - p.opened_at) / 86_400_000;
  if (ageDays >= cfg.moon_bag_max_days) return { sellTokens: p.tokens_remaining, reason: `time_limit_${cfg.moon_bag_max_days}d`, phase: "closed", closeAll: true };

  if (p.exit_plan === "B") {
    const stages = [2.5, 3, 4, 6];
    const next = stages[p.stages_done];
    if (next !== undefined && mult >= next) {
      const last = p.stages_done === stages.length - 1;
      const sell = last ? p.tokens_remaining : Math.min(p.tokens_remaining, p.tokens_bought * 0.25);
      return { sellTokens: sell, reason: `B_stage${p.stages_done + 1}_${next}x`, phase: last ? "closed" : p.stages_done + 1 >= 2 ? "post_tp2" : "post_tp1", closeAll: last };
    }
    return null;
  }

  if (p.exit_plan === "C") {
    if (p.phase === "pre_tp1") {
      if (mult >= cfg.tp1_multiple) return { sellTokens: Math.min(p.tokens_remaining, p.tokens_bought * 0.5), reason: `C_tp1_${cfg.tp1_multiple}x`, phase: "post_tp1", closeAll: false };
      return null;
    }
    if (price <= peak * 0.65) return { sellTokens: p.tokens_remaining, reason: "C_trailing_-35%", phase: "closed", closeAll: true };
    return null;
  }

  // live és variánsai
  const moonTarget = p.exit_plan === "moon10" ? 10 : p.exit_plan === "moon30" ? 30 : cfg.moon_target_multiple;
  const trailPct = p.exit_plan === "trail40" ? 40 : p.exit_plan === "trail60" ? 60 : cfg.trailing_stop_pct;
  if (p.phase === "pre_tp1") {
    if (mult >= cfg.tp1_multiple) return { sellTokens: Math.min(p.tokens_remaining, p.tokens_bought * cfg.tp1_sell_pct / 100), reason: `tp1_${cfg.tp1_multiple}x`, phase: "post_tp1", closeAll: false };
    return null;
  }
  if (p.phase === "post_tp1") {
    if (mult >= cfg.tp2_multiple) return { sellTokens: Math.min(p.tokens_remaining, p.tokens_bought * cfg.tp2_sell_pct / 100), reason: `tp2_${cfg.tp2_multiple}x`, phase: "moon_bag", closeAll: false };
    if (!cfg.trailing_active_after_tp2 && price <= peak * (1 - trailPct / 100)) return { sellTokens: p.tokens_remaining, reason: `trailing_-${trailPct}%`, phase: "closed", closeAll: true };
    return null;
  }
  // moon bag (5x után): 20x cél, trailing a csúcstól, 7 nap (fent)
  if (mult >= moonTarget) return { sellTokens: p.tokens_remaining, reason: `moon_${moonTarget}x`, phase: "closed", closeAll: true };
  if (price <= peak * (1 - trailPct / 100)) return { sellTokens: p.tokens_remaining, reason: `trailing_-${trailPct}%`, phase: "closed", closeAll: true };
  return null;
}

/** 7.3 Vészkilépés-feltételek, Jev nélkül. Az első teljesülő ok. */
export function emergencyReason(p: PosState, price: number, sig: { creatorSoldPct: number | null; liquidityDropPct: number | null; sellSimFailed: boolean; regime: string; scammerBigSell: boolean },
  cfg: Config["emergency"], regimeCfg: Config["regime"]): string | null {
  if (sig.sellSimFailed) return "sell_simulation_failed";
  if (price <= p.entry_price * (1 - cfg.price_drop_pct / 100)) return `price_drop_-${cfg.price_drop_pct}%`;
  if (sig.creatorSoldPct !== null && sig.creatorSoldPct >= cfg.creator_sell_pct) return `creator_sold_${Math.round(sig.creatorSoldPct)}%`;
  if (sig.scammerBigSell) return "scammer_wallet_sell";
  if (sig.liquidityDropPct !== null && sig.liquidityDropPct >= cfg.liquidity_drop_pct) return `liquidity_drop_-${Math.round(sig.liquidityDropPct)}%`;
  if (sig.regime === "risk_off" && regimeCfg.risk_off_close_phases.includes(p.phase as "pre_tp1" | "post_tp1" | "moon_bag")) return "regime_risk_off";
  return null;
}

/** 7.2 Adaptív figyelési gyakoriság (mp). */
export function checkIntervalSec(p: PosState, now: number, cfg: Config["monitoring"]): number {
  if (p.phase === "moon_bag" || p.phase === "post_tp2") return cfg.moon_bag_interval_sec;
  const ageMin = (now - p.opened_at) / 60_000;
  if (ageMin < 5) return cfg.first_5min_interval_sec;
  if (ageMin < 60) return cfg.after_5min_interval_sec;
  return cfg.after_1h_interval_sec;
}
