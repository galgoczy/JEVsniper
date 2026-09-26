import type { DB } from "../db/index.js";
import { nowMs, todayUtc } from "../db/index.js";
import type { Config } from "../config.js";
import { stopFileExists } from "../killswitch.js";

/** 4. Kemény kockázati korlátok – kódban, a stratégiától függetlenül. Visszaadja az első sértett korlátot, vagy null-t. */
export function riskBlock(db: DB, cfg: Config, t: { id: number; chain: string; creator: string | null }, opts: { jevPaused: boolean; regime: string; consecutiveFailed: number }): string | null {
  const r = cfg.risk;
  if (stopFileExists()) return "stop_file";
  if (opts.jevPaused) return "jev_paused";
  if (opts.regime === "risk_off") return "regime_risk_off";
  if (opts.consecutiveFailed >= r.max_consecutive_failed_tx) return "max_consecutive_failed_tx";
  const open = (db.prepare("SELECT COUNT(*) n FROM positions WHERE arm = 'live' AND closed_at IS NULL").get() as { n: number }).n;
  if (open >= r.max_open_positions) return "max_open_positions";
  const perHour = (db.prepare("SELECT COUNT(*) n FROM positions WHERE arm = 'live' AND opened_at > ?").get(nowMs() - 3_600_000) as { n: number }).n;
  if (perHour >= r.max_entries_per_hour) return "max_entries_per_hour";
  const day = db.prepare("SELECT entries, realized_pnl_usd FROM daily_state WHERE day = ?").get(todayUtc()) as { entries: number; realized_pnl_usd: number } | undefined;
  if ((day?.entries ?? 0) >= r.max_entries_per_day) return "max_entries_per_day";
  const cs = db.prepare("SELECT deposit_usd, growth_pool_usd FROM compound_state WHERE id = 1").get() as { deposit_usd: number; growth_pool_usd: number } | undefined;
  const working = (cs?.deposit_usd ?? r.deposit_cap_usd) + (cs?.growth_pool_usd ?? 0);
  if ((day?.realized_pnl_usd ?? 0) <= -(working * r.daily_loss_limit_pct_of_working_capital) / 100) return "daily_loss_limit";
  if (r.one_entry_per_token && (db.prepare("SELECT COUNT(*) n FROM positions WHERE arm = 'live' AND token_id = ?").get(t.id) as { n: number }).n > 0) return "already_entered_token";
  if (t.creator) {
    const c = (db.prepare(`SELECT COUNT(*) n FROM positions p JOIN tokens tk ON tk.id = p.token_id WHERE p.arm = 'live' AND p.opened_at > ? AND tk.chain = ? AND lower(tk.creator) = lower(?)`)
      .get(nowMs() - 86_400_000, t.chain, t.creator) as { n: number }).n;
    if (c >= r.max_entries_per_creator_per_day) return "creator_daily_limit";
  }
  // betét-plafon: a nyitott élő pozíciók összege + az új nem lépheti túl a betétet
  const exposure = (db.prepare("SELECT COALESCE(SUM(size_usd),0) s FROM positions WHERE arm = 'live' AND closed_at IS NULL").get() as { s: number }).s;
  const posUsd = (db.prepare("SELECT position_usd FROM compound_state WHERE id = 1").get() as { position_usd: number } | undefined)?.position_usd ?? r.base_position_usd;
  if (exposure + posUsd > (cs?.deposit_usd ?? r.deposit_cap_usd) + (cs?.growth_pool_usd ?? 0)) return "deposit_cap";
  return null;
}

export function currentPositionUsd(db: DB, cfg: Config): number {
  const cs = db.prepare("SELECT position_usd FROM compound_state WHERE id = 1").get() as { position_usd: number } | undefined;
  return Math.min(cfg.risk.max_position_usd, cs?.position_usd ?? cfg.risk.base_position_usd);
}
