import type { DB } from "../db/index.js";
import { nowMs } from "../db/index.js";
import type { Config } from "../config.js";
import { JevClient } from "../jev/client.js";
import { regimeQuestions } from "../jev/questions.js";
import type { Regime } from "./rules.js";
import { log } from "../logger.js";

/**
 * 6.2 Piaci rezsim, óránként. Bemenetek: ETH ár most / 24h / 7d (saját óránkénti ár-napló a DB-ben),
 * launchpadok 24 órás graduációs aránya és indítás-száma, gasár. Meme-szektor és Pump.fun volumen: nincs
 * ingyenes on-chain forrás → unknown (11. lépés). Jev choice adja; kemény felülírás: ETH 24h esés > X% → risk_off.
 */
export class RegimeGate {
  private current: Regime = "normal";
  private lastAt = 0;
  constructor(private db: DB, private cfg: Config, private jev: JevClient, private ethUsd: () => Promise<number | "unknown">, private gasGwei: () => Promise<Record<string, number | null>>) {
    const last = db.prepare("SELECT regime FROM regime_log ORDER BY id DESC LIMIT 1").get() as { regime: Regime } | undefined;
    if (last) this.current = last.regime;
  }
  get regime(): Regime { return this.current; }

  private recordPrice(usd: number) {
    this.db.prepare("INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(`eth_usd_${Math.floor(nowMs() / 3_600_000)}`, String(usd));
  }
  private priceAgo(hours: number): number | null {
    const k = `eth_usd_${Math.floor(nowMs() / 3_600_000) - hours}`;
    const r = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(k) as { value: string } | undefined;
    return r ? Number(r.value) : null;
  }

  async refresh(force = false): Promise<Regime> {
    if (!force && nowMs() - this.lastAt < this.cfg.regime.recalc_minutes * 60_000) return this.current;
    this.lastAt = nowMs();
    const eth = await this.ethUsd();
    if (typeof eth === "number") this.recordPrice(eth);
    const p24 = this.priceAgo(24), p7d = this.priceAgo(24 * 7);
    const chg24 = typeof eth === "number" && p24 ? ((eth - p24) / p24) * 100 : null;
    const chg7d = typeof eth === "number" && p7d ? ((eth - p7d) / p7d) * 100 : null;
    const lp = this.db.prepare(`SELECT chain, launchpad, COUNT(*) n, SUM(graduated_at IS NOT NULL) g, SUM(discovered_at > ?) n1h FROM tokens WHERE discovered_at > ? AND launchpad != 'uniswap' GROUP BY chain, launchpad`)
      .all(nowMs() - 3_600_000, nowMs() - 86_400_000) as { chain: string; launchpad: string; n: number; g: number; n1h: number }[];
    const gas = await this.gasGwei().catch(() => ({}));
    const inputs = {
      eth_usd: eth, eth_change_24h_pct: chg24 !== null ? Number(chg24.toFixed(2)) : "unknown", eth_change_7d_pct: chg7d !== null ? Number(chg7d.toFixed(2)) : "unknown",
      launchpads_24h: lp.map((r) => ({ ...r, graduation_rate: r.n ? Number((r.g / r.n).toFixed(3)) : 0 })),
      meme_sector_volume_24h: "unknown", pumpfun_volume_24h: "unknown", dex_volume_24h: "unknown", gas_gwei: gas,
    };
    let regime: Regime = this.current, source = "jev", callId: number | null = null;
    if (chg24 !== null && chg24 < -this.cfg.regime.eth_24h_drop_pct_risk_off) { regime = "risk_off"; source = "hard_override"; }
    else if (this.jev.disabled) { source = "jev_disabled"; } // Jev nélkül: marad az előző (alapból normal), csak az ETH-esés kapcsol risk_off-ra
    else {
      try {
        const r = await this.jev.ask(inputs, regimeQuestions, { purpose: "regime" });
        regime = r.answers.regime.choice as Regime; callId = r.callId;
        if (regime === "risk_off" && r.answers.regime.probabilities.risk_off < this.cfg.regime.jev_risk_off_min_p) { regime = "cold"; source = "jev_softened"; }
      } catch (e) { log.warn("rezsim: Jev hiba, marad az előző", { error: (e as Error).message.slice(0, 120) }); source = "jev_error"; }
    }
    if (regime !== this.current) log.info("Rezsimváltás", { from: this.current, to: regime, source });
    this.current = regime;
    this.db.prepare("INSERT INTO regime_log(at, regime, source, inputs_json, jev_call_id) VALUES (?,?,?,?,?)").run(nowMs(), regime, source, JSON.stringify(inputs), callId);
    return regime;
  }
}
