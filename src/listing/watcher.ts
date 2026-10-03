import type { DB } from "../db/index.js";
import { nowMs } from "../db/index.js";
import type { Config } from "../config.js";
import { log } from "../logger.js";
import { coinbaseCurrencies, coinbaseProducts, robinhoodPairs, dexTokens, dexSearch, type Fetch } from "./sources.js";
import { simulate, LISTING_PLANS, type Sample } from "./sim.js";

/**
 * Listázás-figyelő: Coinbase (Base tokenek) és Robinhood (Robinhood Chain tokenek).
 *  - Percenként lekéri a listákat; ami új, arról esemény + Telegram; első futáskor csak alapállapot (esemény nélkül).
 *  - Esemény = árnyék-belépés az észleléskori DexScreener-áron (1 USD), utána ár-mintavétel 7 napig
 *    (az első 2 órában minden körben, utána 10 percenként). Az eredményt a sim.ts tervei számolják.
 *  - Valódi vétel nincs: a legtöbb listázott token nem v4 poolban kereskedik, arra még nincs végrehajtási útvonal.
 */
export interface ListingDeps { db: DB; cfg: Config; fetch?: Fetch; notify: (m: string) => Promise<unknown> }

export class ListingWatcher {
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  stats = { polls: 0, events: 0, samples: 0, errors: 0 };
  constructor(private d: ListingDeps) {}
  private get f(): Fetch { return this.d.fetch ?? fetch; }

  start() {
    if (!this.d.cfg.listing.enabled) return;
    const run = () => void this.tick().catch((e) => { this.stats.errors++; log.warn("listázás-figyelő hiba", { error: (e as Error).message.slice(0, 160) }); });
    run();
    this.timer = setInterval(run, this.d.cfg.listing.poll_interval_sec * 1000);
  }
  stop() { if (this.timer) clearInterval(this.timer); }

  /** Új kulcsok egy forrásban; ha a forrásnak még nincs alapállapota, most rögzítjük és nem jelzünk. */
  private fresh(source: string, keys: string[]): string[] {
    const { db } = this.d;
    const had = (db.prepare("SELECT COUNT(*) n FROM listing_seen WHERE source = ?").get(source) as { n: number }).n > 0;
    const ins = db.prepare("INSERT OR IGNORE INTO listing_seen(source, key, first_seen) VALUES (?,?,?)");
    const out: string[] = [];
    db.transaction(() => { for (const k of keys) if (ins.run(source, k, nowMs()).changes && had) out.push(k); })();
    return out;
  }

  async tick(): Promise<void> {
    if (this.busy) return; this.busy = true;
    try {
      const L = this.d.cfg.listing;
      if (L.coinbase) await this.coinbase().catch((e) => { this.stats.errors++; log.warn("Coinbase lista hiba", { error: (e as Error).message.slice(0, 120) }); });
      if (L.robinhood) await this.robinhood().catch((e) => { this.stats.errors++; log.warn("Robinhood lista hiba", { error: (e as Error).message.slice(0, 120) }); });
      await this.sample();
      this.stats.polls++;
    } finally { this.busy = false; }
  }

  private async coinbase() {
    const [cur, prod] = await Promise.all([coinbaseCurrencies(this.f), coinbaseProducts(this.f)]);
    const baseAddr = new Map(cur.filter((c) => c.baseContract).map((c) => [c.id, c.baseContract!]));
    for (const id of this.fresh("coinbase_currency", cur.map((c) => c.id))) {
      const a = baseAddr.get(id); if (a) await this.event("coinbase", "currency_added", id, "base", a, "új Coinbase-eszköz Base szerződéssel");
    }
    for (const pid of this.fresh("coinbase_product", prod.filter((p) => p.tradable).map((p) => p.id))) {
      const base = pid.split("-")[0]!; const a = baseAddr.get(base);
      if (a) await this.event("coinbase", "trading_live", base, "base", a, `kereskedés indul: ${pid}`);
    }
  }

  private async robinhood() {
    const pairs = await robinhoodPairs(this.f);
    for (const key of this.fresh("robinhood_pair", pairs.filter((p) => p.tradable).map((p) => p.key))) {
      const p = pairs.find((x) => x.key === key)!;
      // cím feloldása: DexScreener keresés, Robinhood Chain pár, egyező szimbólum, legnagyobb likviditás
      const cands = (await dexSearch(this.f, p.code).catch(() => [])).filter((x) => x.chainId.toLowerCase().includes(this.d.cfg.listing.robinhood_chain_match) && x.baseSymbol.toLowerCase() === p.code.toLowerCase() && x.priceUsd !== null);
      const best = cands.sort((a, b) => (b.liqUsd ?? 0) - (a.liqUsd ?? 0))[0];
      await this.event("robinhood", "rh_tradable", p.code, best ? "robinhood" : null, best?.baseAddress ?? null,
        best ? `Robinhood-appban kereskedhető; cím DexScreenerből (${cands.length} jelölt, a legnagyobb likviditású)` : "Robinhood-appban kereskedhető; Robinhood Chain címe nem található (valószínűleg más láncon van)");
    }
  }

  private async event(source: string, kind: string, symbol: string, chain: string | null, address: string | null, note: string) {
    const { db } = this.d;
    let price: number | null = null, liq: number | null = null, dex: string | null = null;
    if (address) {
      const m = await dexTokens(this.f, [address]).catch(() => new Map());
      const p = m.get(address.toLowerCase());
      if (p) { price = p.priceUsd; liq = p.liqUsd; dex = `${p.chainId}/${p.dexId}`; }
    }
    const r = db.prepare("INSERT OR IGNORE INTO listing_events(source, kind, symbol, chain, address, detected_at, entry_price_usd, entry_liq_usd, dex_id, note) VALUES (?,?,?,?,?,?,?,?,?,?)")
      .run(source, kind, symbol, chain, address, nowMs(), price, liq, dex, note);
    if (!r.changes) return;
    this.stats.events++;
    if (price !== null) db.prepare("INSERT OR IGNORE INTO listing_prices(event_id, at, price_usd, liq_usd) VALUES (?,?,?,?)").run(Number(r.lastInsertRowid), nowMs(), price, liq);
    const where = address ? `${chain ?? "?"} ${address}` : "cím nélkül";
    await this.d.notify(`📣 Listázás (${source}, ${kind}): ${symbol} – ${where}\n${note}\n${price !== null ? `árnyék-belépés ${price.toPrecision(4)} USD, likviditás ${liq !== null ? Math.round(liq) + " USD" : "?"} (${dex})` : "ár nem elérhető – nincs belépés"}`);
  }

  /** Ár-mintavétel az aktív eseményekre (DexScreener, 30-as kötegekben). */
  private async sample() {
    const { db, cfg } = this.d;
    const now = nowMs();
    const evs = db.prepare(`SELECT e.id, e.address, e.detected_at, (SELECT MAX(at) FROM listing_prices p WHERE p.event_id = e.id) last
      FROM listing_events e WHERE e.address IS NOT NULL AND e.entry_price_usd IS NOT NULL AND e.detected_at > ?`).all(now - cfg.listing.track_days * 86_400_000) as Array<{ id: number; address: string; detected_at: number; last: number | null }>;
    const due = evs.filter((e) => now - e.detected_at < 2 * 3_600_000 || !e.last || now - e.last >= 10 * 60_000);
    if (!due.length) return;
    const m = await dexTokens(this.f, [...new Set(due.map((e) => e.address))]);
    const ins = db.prepare("INSERT OR IGNORE INTO listing_prices(event_id, at, price_usd, liq_usd) VALUES (?,?,?,?)");
    for (const e of due) { const p = m.get(e.address.toLowerCase()); if (p?.priceUsd) { this.stats.samples += ins.run(e.id, now, p.priceUsd, p.liqUsd).changes; } }
  }
}

/** Összesítés tervenként (riport, /allas): esemény-szám, átlagos érték 1 USD-re, lezártak száma. */
export function listingSummary(db: DB, cfg: Config, sinceMs: number): { events: number; plans: Array<{ name: string; n: number; mean: number; closed: number }>; rows: Array<{ symbol: string; source: string; kind: string; detected_at: number; values: Record<string, number> }> } {
  const evs = db.prepare("SELECT id, source, kind, symbol, chain, detected_at, entry_price_usd, entry_liq_usd FROM listing_events WHERE detected_at > ? AND entry_price_usd IS NOT NULL ORDER BY detected_at").all(sinceMs) as Array<{ id: number; source: string; kind: string; symbol: string; chain: string | null; detected_at: number; entry_price_usd: number; entry_liq_usd: number | null }>;
  const acc = new Map(LISTING_PLANS.map((p) => [p.name, { name: p.name, n: 0, sum: 0, closed: 0 }]));
  const rows: Array<{ symbol: string; source: string; kind: string; detected_at: number; values: Record<string, number> }> = [];
  for (const e of evs) {
    const series = db.prepare("SELECT at, price_usd price, liq_usd liq FROM listing_prices WHERE event_id = ? ORDER BY at").all(e.id) as Sample[];
    const cm = (cfg.cost_model as Record<string, { gas_buy_usd: number; gas_sell_usd: number }>)[e.chain ?? "base"] ?? { gas_buy_usd: 0.01, gas_sell_usd: 0.01 };
    const values: Record<string, number> = {};
    for (const p of LISTING_PLANS) {
      const r = simulate(e.detected_at, e.entry_price_usd, e.entry_liq_usd, series, p, { gasBuyUsd: cm.gas_buy_usd, gasSellUsd: cm.gas_sell_usd }, cfg.listing.size_usd);
      values[p.name] = r.value;
      const a = acc.get(p.name)!; a.n++; a.sum += r.value; if (r.closed) a.closed++;
    }
    rows.push({ symbol: e.symbol, source: e.source, kind: e.kind, detected_at: e.detected_at, values });
  }
  return { events: evs.length, plans: [...acc.values()].map((a) => ({ name: a.name, n: a.n, mean: a.n ? a.sum / a.n : 0, closed: a.closed })), rows };
}
