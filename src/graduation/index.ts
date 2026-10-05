import { isAddressEqual, type Address } from "viem";
import type { DB } from "../db/index.js";
import type { Config } from "../config.js";
import { ADDRESSES, ZERO } from "../chains/addresses.js";
import { priceFromSqrtX96 } from "../collector/stats.js";
import { tokenRow, type TokenRow } from "../collector/index.js";
import type { ParamSnapshot } from "../collector/types.js";
import { hardFilters } from "../filters/hard.js";
import { log } from "../logger.js";

/**
 * V2 – graduációs szakasz (PONS: a bonding curve-ről Uniswap v4 poolba lépés). Árnyékkarok:
 *  grad_at      – belépés a graduáció észlelésekor, a pool induló árán (alapvonal: minden graduált token)
 *  grad_30s     – 30 mp-cel később, friss pillanatkép VALÓDI pool-árán, szűrő nélkül (2026-10-05: a grad_at induló ára
 *                 valószínűleg elérhetetlen – a gyors botok előbb vesznek; a kettő különbsége az ár-optimizmus mértéke)
 *  grad_15_all  – 15 perccel később, minden graduált token, amely átmegy a kemény szűrőn (azonos időzítésű alapvonal)
 *  grad_15_hold – mint az előző, de csak ha az ár a graduációs ár fölött van, van valódi ETH a poolban, és a készítő
 *                 nem adta el a kezdeti tokenjei felét → „graduált, nem omlott össze, konszolidál”
 * A pozíciók ablak-címkéje 0 (eseményvezérelt); a 15 perces pillanatkép a snapshots táblában 900-as címkével.
 */
export const GRAD_SNAPSHOT_WINDOW = 900;
/** a +30 mp-es graduációs pillanatkép címkéje (nem ütközik az indulási 30/60/180 mp-es ablakokkal) */
export const GRAD30_SNAPSHOT_WINDOW = 930;

export interface GraduationDeps {
  db: DB; cfg: Config;
  collect: (t: TokenRow, windowSec: number) => Promise<ParamSnapshot>;
  saveSnapshot: (t: TokenRow, snap: ParamSnapshot) => void;
  openShadow: (t: TokenRow, arm: string, price: number, ethUsd: number, liquidityNative: number | null) => number;
  ethUsd: () => Promise<number | "unknown">;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** A 15 perces feltétel (tiszta függvény, tesztelhető). */
export function gradHoldOk(snap: ParamSnapshot, gradPrice: number): { ok: boolean; reasons: string[] } {
  const r: string[] = [];
  const p = num(snap.dynamics.price_native);
  if (p === null || p < gradPrice) r.push(`ár ${p === null ? "ismeretlen" : (p / gradPrice).toFixed(2) + "x"} a graduációs árhoz`);
  const liq = num(snap.contract.liquidity_native);
  if (liq === null || liq <= 0) r.push("nincs valódi ETH a poolban");
  const sold = num(snap.creator.sold_pct_of_initial);
  if (sold !== null && sold >= 50) r.push(`készítő eladott ${sold.toFixed(0)}%`);
  return { ok: r.length === 0, reasons: r };
}

export class GraduationTracker {
  private timers = new Set<NodeJS.Timeout>();
  stats = { graduations: 0, entries: 0, at30: 0, delayed: 0, holds: 0 };
  constructor(private d: GraduationDeps) {}

  /** A watcher hívja az első graduáció-észleléskor. */
  async onGraduation(tokenId: number, initSqrtPriceX96: bigint | null): Promise<void> {
    const { db, cfg } = this.d;
    if (!cfg.graduation.enabled) return;
    const t = tokenRow(db, tokenId);
    if (!t || t.launchpad !== "pons") return;
    this.stats.graduations++;
    const pair = (t.pair_token ?? ZERO) as Address;
    const native = isAddressEqual(pair, ZERO) || isAddressEqual(pair, ADDRESSES[t.chain].weth);
    if (!native || initSqrtPriceX96 === null) { log.info("Graduáció nem natív párral vagy ár nélkül – kihagyva", { token: t.symbol }); return; }
    const tokenIsC0 = BigInt(t.address) < BigInt(pair);
    const gradPrice = priceFromSqrtX96(initSqrtPriceX96, tokenIsC0, t.decimals ?? 18);
    const eth = await this.d.ethUsd();
    if (typeof eth === "number" && gradPrice > 0 && this.d.openShadow(t, "grad_at", gradPrice, eth, null) > 0) this.stats.entries++;
    // 30 mp múlva: reális késéssel, a valódi pool-áron
    const h30 = setTimeout(() => { this.timers.delete(h30); void this.delayed30(tokenId).catch((e) => log.warn("graduáció +30 mp hiba", { token: t.symbol, error: (e as Error).message.slice(0, 160) })); }, 30_000);
    this.timers.add(h30);
    // 15 perc múlva: friss pillanatkép, kemény szűrő, feltétel
    const h = setTimeout(() => { this.timers.delete(h); void this.delayed(tokenId, gradPrice).catch((e) => log.warn("graduáció +15 perc hiba", { token: t.symbol, error: (e as Error).message.slice(0, 160) })); }, cfg.graduation.delay_min * 60_000);
    this.timers.add(h);
  }

  /** +30 mp: friss pillanatkép, belépés a valódi pool-áron, szűrő nélkül (a grad_at reális párja). */
  async delayed30(tokenId: number): Promise<void> {
    const row = tokenRow(this.d.db, tokenId);
    if (!row) return;
    const snap = await this.d.collect(row, GRAD30_SNAPSHOT_WINDOW);
    this.d.saveSnapshot(row, snap);
    const price = num(snap.dynamics.price_native), eth = num(snap.meta_snapshot.eth_usd);
    if (price === null || !(price > 0) || eth === null) return;
    if (this.d.openShadow(row, "grad_30s", price, eth, num(snap.contract.liquidity_native)) > 0) this.stats.at30++;
  }

  async delayed(tokenId: number, gradPrice: number): Promise<void> {
    const row = tokenRow(this.d.db, tokenId);
    if (!row) return;
    const snap = await this.d.collect(row, GRAD_SNAPSHOT_WINDOW);
    this.d.saveSnapshot(row, snap);
    this.stats.delayed++;
    if (!hardFilters(snap, this.d.cfg.hard_filters).pass) return;
    const price = num(snap.dynamics.price_native), eth = num(snap.meta_snapshot.eth_usd);
    if (price === null || eth === null) return;
    const liq = num(snap.contract.liquidity_native);
    this.d.openShadow(row, "grad_15_all", price, eth, liq);
    const hold = gradHoldOk(snap, gradPrice);
    if (hold.ok && this.d.openShadow(row, "grad_15_hold", price, eth, liq) > 0) this.stats.holds++;
  }

  stop() { for (const h of this.timers) clearTimeout(h); this.timers.clear(); }
}
