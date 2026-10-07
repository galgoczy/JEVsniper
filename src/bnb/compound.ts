import type { DB } from "../db/index.js";
import { nowMs, logEvent } from "../db/index.js";
import type { Config } from "../config.js";
import { isLocalTime } from "../compound/index.js";
import { log } from "../logger.js";

/**
 * BNB élő láb visszaforgatása (2026-10-08, a felhasználó szabálya):
 *  - naponta 03:01 helyi idő (compound.recalc_time_local / recalc_timezone; az óraátállítást kikerüli);
 *  - a nap nettó eredménye (az utolsó újraszámolás óta zárt élő BNB-pozíciók): NYERESÉG → 30%-a a tőkéhez, 70% tartalékba (nem forog);
 *    VESZTESÉG → 100%-ban a tőkét csökkenti;
 *  - pozícióméret = alapméret × (tőke / induló tőke), legalább MIN_POSITION_USD (a gáz miatt kisebb nem ésszerű); menet közben nem változik.
 * Induló tőke = position_usd × max_open (config), az első futáskor.
 */
export const MIN_POSITION_USD = 1;
export interface BnbCompoundState { initial_capital_usd: number; capital_usd: number; reserve_usd: number; position_usd: number; last_recalc_at: number }

export function applyDay(s: BnbCompoundState, dayNet: number, share: number, basePosition: number): BnbCompoundState {
  const n = { ...s };
  if (dayNet > 0) { n.capital_usd += dayNet * share; n.reserve_usd += dayNet * (1 - share); }
  else if (dayNet < 0) n.capital_usd = Math.max(0, n.capital_usd + dayNet);
  n.position_usd = Math.max(MIN_POSITION_USD, basePosition * (n.capital_usd / n.initial_capital_usd));
  return n;
}

export class BnbCompound {
  constructor(private db: DB, private cfg: Config, private notify: (m: string) => Promise<unknown>, private now: () => number = nowMs) { this.ensure(); }
  private ensure() {
    const L = this.cfg.bnb_live, cap = L.position_usd * L.max_open;
    this.db.prepare("INSERT OR IGNORE INTO bnb_compound_state(id, initial_capital_usd, capital_usd, reserve_usd, position_usd, last_recalc_at, updated_at) VALUES (1,?,?,0,?,?,?)").run(cap, cap, L.position_usd, this.now(), this.now());
  }
  state(): BnbCompoundState { return this.db.prepare("SELECT initial_capital_usd, capital_usd, reserve_usd, position_usd, last_recalc_at FROM bnb_compound_state WHERE id = 1").get() as BnbCompoundState; }
  /** Az aktuális élő pozícióméret (USD). */
  positionUsd(): number { return this.state().position_usd; }

  /** Napi újraszámolás: az utolsó óta zárt élő BNB-pozíciók nettója (a füstpróba nem számít). */
  async recalc(reason = "daily"): Promise<number> {
    const s = this.state();
    const r = this.db.prepare("SELECT COALESCE(SUM(net_usd),0) net, COUNT(*) n FROM bnb_live_positions WHERE closed_at IS NOT NULL AND closed_at > ? AND arm <> 'fustproba'").get(s.last_recalc_at) as { net: number; n: number };
    const n = applyDay(s, r.net, this.cfg.compound.profit_share_to_growth_pool, this.cfg.bnb_live.position_usd);
    this.db.prepare("UPDATE bnb_compound_state SET capital_usd=?, reserve_usd=?, position_usd=?, last_recalc_at=?, updated_at=? WHERE id=1").run(n.capital_usd, n.reserve_usd, n.position_usd, this.now(), this.now());
    logEvent(this.db, "bnb_size_change", `${s.position_usd.toFixed(2)} → ${n.position_usd.toFixed(2)} (${reason}, nap ${r.net.toFixed(2)} USD, n=${r.n})`);
    log.info("BNB visszaforgatás", { nap_netto: Number(r.net.toFixed(3)), zart: r.n, toke: Number(n.capital_usd.toFixed(3)), tartalek: Number(n.reserve_usd.toFixed(3)), meret: Number(n.position_usd.toFixed(3)) });
    await this.notify(`📐 BNB visszaforgatás: a nap ${r.net >= 0 ? "+" : ""}${r.net.toFixed(2)} USD (${r.n} zárás) → tőke ${n.capital_usd.toFixed(2)} USD (tartalék ${n.reserve_usd.toFixed(2)}), pozícióméret ${s.position_usd.toFixed(2)} → ${n.position_usd.toFixed(2)} USD`);
    return n.position_usd;
  }

  schedule(): NodeJS.Timeout {
    let lastDay = "";
    return setInterval(() => {
      const day = new Date(this.now()).toISOString().slice(0, 13); // óra-felbontású védelem a dupla futás ellen
      if (lastDay !== day && isLocalTime(this.cfg.compound.recalc_time_local, this.cfg.compound.recalc_timezone, new Date(this.now()))) { lastDay = day; void this.recalc().catch((e) => log.warn("BNB visszaforgatás hiba", { error: (e as Error).message })); }
    }, 60_000);
  }
}
