import type { DB } from "../db/index.js";
import { nowMs, logEvent } from "../db/index.js";
import type { Config } from "../config.js";
import { log } from "../logger.js";

export interface CompoundState { deposit_usd: number; growth_pool_usd: number; reserve_usd: number; working_capital_peak_usd: number; position_usd: number; updated_at: number }

/**
 * 5. Compound-szabály – tiszta függvények + DB-állapot.
 *  - lezárt élő pozíció nettó eredménye: nyereség 30% → növekedési kassza, 70% → tartalék; veszteség a betétet, majd a kasszát csökkenti, a tartalékot soha
 *  - forgó tőke = betét + kassza; csúcs követve; csúcstól -30% → a kassza fele számít a méretbe, amíg új csúcs nincs
 *  - pozícióméret naponta 0:00 UTC: min(max, base + effektív kassza / max_open_positions); menet közben nem változik
 *  - opcionális kar: méretnövelés csak akkor, ha az utolsó 7 nap élő eredménye jobb a random_control-nál
 */
export function applyClose(s: CompoundState, netUsd: number, share: number): CompoundState {
  const n = { ...s };
  if (netUsd > 0) { n.growth_pool_usd += netUsd * share; n.reserve_usd += netUsd * (1 - share); }
  else if (netUsd < 0) {
    let loss = -netUsd;
    const fromDeposit = Math.min(n.deposit_usd, loss); n.deposit_usd -= fromDeposit; loss -= fromDeposit;
    const fromGrowth = Math.min(n.growth_pool_usd, loss); n.growth_pool_usd -= fromGrowth;
  }
  n.working_capital_peak_usd = Math.max(n.working_capital_peak_usd, n.deposit_usd + n.growth_pool_usd);
  return n;
}

export function effectiveGrowth(s: CompoundState, drawdownHalvingPct: number): { effective: number; inDrawdown: boolean } {
  const working = s.deposit_usd + s.growth_pool_usd;
  const inDrawdown = s.working_capital_peak_usd > 0 && working <= s.working_capital_peak_usd * (1 - drawdownHalvingPct / 100);
  return { effective: inDrawdown ? s.growth_pool_usd / 2 : s.growth_pool_usd, inDrawdown };
}

export function computePositionUsd(s: CompoundState, risk: Config["risk"], comp: Config["compound"], gateOk: boolean): number {
  const { effective } = effectiveGrowth(s, comp.drawdown_halving_pct);
  const raw = risk.base_position_usd + (gateOk ? effective : 0) / risk.max_open_positions;
  return Math.min(risk.max_position_usd, Math.max(risk.base_position_usd, raw));
}

export class CompoundManager {
  constructor(private db: DB, private cfg: Config, private notify: (t: string) => Promise<unknown>) {}

  state(): CompoundState { return this.db.prepare("SELECT * FROM compound_state WHERE id = 1").get() as CompoundState; }
  private save(s: CompoundState) {
    this.db.prepare("UPDATE compound_state SET deposit_usd=?, growth_pool_usd=?, reserve_usd=?, working_capital_peak_usd=?, position_usd=?, updated_at=? WHERE id=1")
      .run(s.deposit_usd, s.growth_pool_usd, s.reserve_usd, s.working_capital_peak_usd, s.position_usd, nowMs());
  }

  /** Lezárt élő pozíció könyvelése (a monitor onLiveClosed horgáról). */
  onLiveClosed(netUsd: number) {
    const s = applyClose(this.state(), netUsd, this.cfg.compound.profit_share_to_growth_pool);
    this.save(s);
    log.info("compound: lezárás könyvelve", { netUsd: Number(netUsd.toFixed(4)), deposit: s.deposit_usd, growth: s.growth_pool_usd, reserve: s.reserve_usd });
  }

  /** Opcionális kar: az utolsó 7 nap élő átlag nettó > random_control (élő terv) átlag nettó. */
  gateOk(): boolean {
    if (!this.cfg.compound.require_positive_vs_random_control) return true;
    const since = nowMs() - this.cfg.compound.random_control_lookback_days * 86_400_000;
    const live = this.db.prepare("SELECT AVG(net_pnl_usd) a, COUNT(*) n FROM positions WHERE arm='live' AND closed_at > ?").get(since) as { a: number | null; n: number };
    const rc = this.db.prepare("SELECT AVG(net_pnl_usd) a, COUNT(*) n FROM positions WHERE arm='random_control' AND exit_plan='live' AND closed_at > ? AND close_reason NOT LIKE 'invalid%'").get(since) as { a: number | null; n: number };
    if (!live.n || !rc.n || live.a === null || rc.a === null) return false;
    return live.a > rc.a;
  }

  /** Napi újraszámolás (0:00 UTC); méretváltozás → size_changes + Telegram. */
  async recalcDaily(reason = "daily_recalc"): Promise<number> {
    const s = this.state();
    const gate = this.gateOk();
    const { inDrawdown } = effectiveGrowth(s, this.cfg.compound.drawdown_halving_pct);
    const next = computePositionUsd(s, this.cfg.risk, this.cfg.compound, gate);
    if (Math.abs(next - s.position_usd) >= 0.005) {
      this.db.prepare("INSERT INTO size_changes(at, old_position_usd, new_position_usd, growth_pool_usd, reason) VALUES (?,?,?,?,?)").run(nowMs(), s.position_usd, next, s.growth_pool_usd, `${reason}${inDrawdown ? ",drawdown_halving" : ""}${gate ? "" : ",gate_closed"}`);
      logEvent(this.db, "size_change", `${s.position_usd} → ${next}`);
      await this.notify(`📐 Pozícióméret: ${s.position_usd.toFixed(2)} → ${next.toFixed(2)} USD (kassza ${s.growth_pool_usd.toFixed(2)}, tartalék ${s.reserve_usd.toFixed(2)}${inDrawdown ? ", visszaesés: kassza felezve" : ""}${gate ? "" : ", kar zárva: nem jobb a véletlennél"})`);
    }
    this.save({ ...s, position_usd: next });
    return next;
  }

  /** Időzítő: a config recalc_time_utc (HH:MM) pontján naponta. */
  schedule(): NodeJS.Timeout {
    const [hh, mm] = this.cfg.compound.recalc_time_utc.split(":").map(Number) as [number, number];
    const tick = async () => {
      const d = new Date(); if (d.getUTCHours() === hh && d.getUTCMinutes() === mm) await this.recalcDaily().catch((e) => log.warn("compound recalc hiba", { error: (e as Error).message }));
    };
    return setInterval(() => void tick(), 60_000);
  }
}
