import { parseAbi, getAddress, type PublicClient } from "viem";
import type { DB } from "../db/index.js";
import { log } from "../logger.js";

/**
 * BNB / PancakeSwap árnyékkarok (2026-10-07) – a harmadik visszajátszási kör két jelöltje, ELŐRE rögzítve (docs/FELTETELEZESEK.md):
 *  - bnb_all60: minden valódi indítás, belépés +60 mp-nél (ha a pár még él);
 *  - bnb_whale: az első ≥ 1 BNB-s vétel a +60. mp után → belépés.
 * Belépés: a felvevő következő körében (5 mp) a pár AKTUÁLIS árán (Sync-tartalék), és csak ha az eladhatósági próba átment:
 *   egy friss vevő (Swap.to) címéről `eth_call` token.transfer(pár, egyenleg/10) – ha visszadob, a token eladhatatlan (honeypot,
 *   feketelista, „csak vétel”). Token-adót ez nem mér (feltevés: 0) – ezt a kimenetből kell majd ellenőrizni.
 * Kiszállás tervenként: tp2_sl40 (fő: 2× vagy −40% → minden), tp1.5_sl30, C (2×-nél 50%, a maradék a csúcstól −35%; −40% vészfék).
 *   A jelzést a kör alatt látott legmagasabb/legalacsonyabb kötésár adja, a teljesülés a kör végi AKTUÁLIS áron (reakcióidő).
 *   Kiürült pár (WBNB-tartalék < 0,05) → a maradék 0. 6 óra után zárás az utolsó áron. 30 perc után az ár az 5 perces getReserves-ből.
 * Költség oldalanként: 0,25% PancakeSwap-díj + 0,5% MEV/csúszás, tx-enként ~0,006 USD gáz. Méret: 1 USD (árnyék).
 */
export const BNB_ARMS = ["bnb_all60", "bnb_whale"] as const;
export const BNB_PLANS = ["tp2_sl40", "tp1.5_sl30", "C"] as const;
export const BNB_MAIN_PLAN = "tp2_sl40";
const SIDE_COST = 0.0075, GAS_USD = 0.006, RUG_LIQ = 0.05, HORIZON_MS = 6 * 3600_000;
const ENTRY_DELAY_MS = 60_000, ENTRY_MAX_LATE_MS = 60_000, WHALE_BNB = 1;
const ERC20 = parseAbi(["function balanceOf(address) view returns (uint256)", "function transfer(address,uint256) returns (bool)"]);
const IGNORE_TO = new Set(["0x10ed43c718714eb63d5aa57b78b54704e256024e", "0x0000000000000000000000000000000000000000"]); // PancakeSwap router, nulla cím

export interface PairEvent { pair: string; token: string; createdAt: number; at: number; kind: "trade" | "reserve"; side?: "buy" | "sell"; bnb?: number; to?: string; price: number; liq: number }
interface PairState { token: string; createdAt: number; price: number; liq: number; hi: number; lo: number; buyers: string[]; whaleAt: number | null; all60Done: boolean; whaleDone: boolean }
interface Pos { id: number; pair: string; arm: string; plan: string; entry: number; tokens: number; left: number; received: number; txs: number; phase: string; peak: number; openedAt: number; sizeBnb: number; sizeUsd: number }

export class BnbShadow {
  private st = new Map<string, PairState>();
  private open = new Map<number, Pos>();
  private pending = new Map<string, { pair: string; arm: string; signalAt: number }>();
  private checking = new Set<string>();
  stats = { signals: 0, opened: 0, closed: 0, honeypot: 0, checkErr: 0, noHolder: 0, late: 0 };
  constructor(private d: { db: DB; client: PublicClient; bnbUsd: () => number | null; sizeUsd: () => number; now?: () => number }) { this.restore(); }
  private now() { return (this.d.now ?? Date.now)(); }

  restore() {
    for (const r of this.d.db.prepare("SELECT * FROM bnb_shadow_positions WHERE closed_at IS NULL").all() as Array<Record<string, number | string>>)
      this.open.set(r.id as number, { id: r.id as number, pair: r.pair as string, arm: r.arm as string, plan: r.plan as string, entry: r.entry_price as number, tokens: r.tokens as number, left: r.tokens_left as number,
        received: r.received_bnb as number, txs: r.txs as number, phase: r.phase as string, peak: (r.peak_price as number) ?? (r.entry_price as number), openedAt: r.opened_at as number, sizeBnb: r.size_bnb as number, sizeUsd: r.size_usd as number });
    // a már jelzett párok ne jelezzenek újra
    for (const r of this.d.db.prepare("SELECT DISTINCT pair, arm FROM bnb_shadow_positions UNION SELECT pair, arm FROM bnb_shadow_skips").all() as Array<{ pair: string; arm: string }>) this.done.add(`${r.pair}|${r.arm}`);
  }
  private done = new Set<string>();

  /** A felvevő hívja minden kötésnél (és 30 perc után az 5 perces tartalék-frissítésnél). */
  onEvent(e: PairEvent) {
    let s = this.st.get(e.pair);
    if (!s) { s = { token: e.token, createdAt: e.createdAt, price: e.price, liq: e.liq, hi: e.price, lo: e.price, buyers: [], whaleAt: null, all60Done: false, whaleDone: false }; this.st.set(e.pair, s); }
    s.price = e.price; s.liq = e.liq;
    if (e.price > 0) { s.hi = Math.max(s.hi, e.price); s.lo = s.lo > 0 ? Math.min(s.lo, e.price) : e.price; }
    if (e.kind === "trade" && e.side === "buy" && e.to && !IGNORE_TO.has(e.to.toLowerCase()) && e.to.toLowerCase() !== e.pair) { s.buyers.push(e.to.toLowerCase()); if (s.buyers.length > 20) s.buyers.shift(); }
    if (e.kind === "trade" && e.side === "buy" && (e.bnb ?? 0) >= WHALE_BNB && e.at >= e.createdAt + ENTRY_DELAY_MS && s.whaleAt === null) s.whaleAt = e.at;
  }

  /** A felvevő körének végén: jelzések, eladhatósági próbák, belépések az aktuális áron, kiszállások. */
  async step(): Promise<void> {
    const now = this.now();
    for (const [pair, s] of this.st) {
      // jelzések
      if (!s.all60Done && now >= s.createdAt + ENTRY_DELAY_MS) { s.all60Done = true; this.signal(pair, "bnb_all60", s.createdAt + ENTRY_DELAY_MS, now); }
      if (!s.whaleDone && s.whaleAt !== null) { s.whaleDone = true; this.signal(pair, "bnb_whale", s.whaleAt, now); }
      if (now - s.createdAt > HORIZON_MS + 3600_000 && ![...this.open.values()].some((p) => p.pair === pair)) this.st.delete(pair);
    }
    // eladhatósági próbák (párhuzamosan, legfeljebb 8)
    const todo = [...this.pending.values()].filter((p) => !this.checking.has(`${p.pair}|${p.arm}`)).slice(0, 8);
    await Promise.all(todo.map((p) => this.checkAndOpen(p.pair, p.arm, p.signalAt)));
    // kiszállások
    for (const p of [...this.open.values()]) this.evaluate(p, now);
    for (const s of this.st.values()) { s.hi = s.price; s.lo = s.price; }
  }

  private signal(pair: string, arm: string, signalAt: number, now: number) {
    const key = `${pair}|${arm}`; if (this.done.has(key)) return;
    this.done.add(key); this.stats.signals++;
    if (now - signalAt > ENTRY_MAX_LATE_MS) { this.skip(pair, arm, now, "late"); this.stats.late++; return; } // késve látott jelzés (pl. újraindítás): nem vesszük fel
    this.pending.set(key, { pair, arm, signalAt });
  }
  private skip(pair: string, arm: string, at: number, reason: string) { this.d.db.prepare("INSERT OR IGNORE INTO bnb_shadow_skips(pair, arm, at, reason) VALUES (?,?,?,?)").run(pair, arm, at, reason); }

  private async checkAndOpen(pair: string, arm: string, signalAt: number) {
    const key = `${pair}|${arm}`; this.checking.add(key);
    try {
      const s = this.st.get(pair); if (!s) return;
      if (!(s.price > 0) || s.liq < RUG_LIQ) { this.skip(pair, arm, this.now(), "drained"); return; }
      const res = await this.sellable(pair, s);
      if (res !== "ok") { this.skip(pair, arm, this.now(), res); if (res === "honeypot") this.stats.honeypot++; else if (res === "no_holder") this.stats.noHolder++; else this.stats.checkErr++; return; }
      const usd = this.d.bnbUsd(); if (!usd) { this.skip(pair, arm, this.now(), "no_bnb_usd"); return; }
      const sizeUsd = this.d.sizeUsd(), sizeBnb = sizeUsd / usd, now = this.now();
      const tokens = sizeBnb * (1 - SIDE_COST) / s.price;
      const ins = this.d.db.prepare(`INSERT OR IGNORE INTO bnb_shadow_positions(pair, token, arm, plan, signal_at, opened_at, entry_price, size_usd, size_bnb, tokens, tokens_left, liq_at_entry, peak_price, last_price, last_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
      for (const plan of BNB_PLANS) {
        const r = ins.run(pair, s.token, arm, plan, signalAt, now, s.price, sizeUsd, sizeBnb, tokens, tokens, s.liq, s.price, s.price, now);
        if (r.changes) this.open.set(Number(r.lastInsertRowid), { id: Number(r.lastInsertRowid), pair, arm, plan, entry: s.price, tokens, left: tokens, received: 0, txs: 1, phase: "open", peak: s.price, openedAt: now, sizeBnb, sizeUsd });
      }
      this.stats.opened++;
    } finally { this.pending.delete(key); this.checking.delete(key); }
  }

  /** Eladhatósági próba: egy friss vevő címéről a token átküldése a párba (ez az eladás első lépése) – eth_call, kulcs nélkül. */
  private async sellable(pair: string, s: PairState): Promise<"ok" | "honeypot" | "no_holder" | "error"> {
    const token = getAddress(s.token);
    for (const h of [...new Set(s.buyers)].reverse().slice(0, 3)) {
      try {
        const bal = await this.d.client.readContract({ address: token, abi: ERC20, functionName: "balanceOf", args: [getAddress(h)] }) as bigint;
        if (bal <= 0n) continue;
        try { await this.d.client.call({ account: getAddress(h), to: token, data: encodeTransfer(pair, bal / 10n > 0n ? bal / 10n : bal) }); return "ok"; }
        catch { return "honeypot"; }
      } catch { return "error"; }
    }
    return "no_holder";
  }

  private evaluate(p: Pos, now: number) {
    const s = this.st.get(p.pair); if (!s) return;
    const price = s.price, hi = s.hi, lo = s.lo;
    p.peak = Math.max(p.peak, hi);
    const sell = (amount: number, reason: string, fillPrice: number, close: boolean) => {
      const bnb = amount * fillPrice * (1 - SIDE_COST); p.received += bnb; p.left -= amount; p.txs++;
      if (close || p.left <= p.tokens * 1e-9) this.close(p, now, reason); else this.d.db.prepare("UPDATE bnb_shadow_positions SET tokens_left = ?, received_bnb = ?, txs = ?, phase = ? WHERE id = ?").run(p.left, p.received, p.txs, p.phase, p.id);
    };
    if (s.liq < RUG_LIQ) { p.left = 0; this.close(p, now, "drained"); return; }
    if (now - p.openedAt >= HORIZON_MS) { sell(p.left, "time_6h", price, true); return; }
    const x = (v: number) => v / p.entry;
    const scalp = /^tp([\d.]+)_sl(\d+)$/.exec(p.plan);
    if (scalp) {
      const tp = Number(scalp[1]), sl = 1 - Number(scalp[2]) / 100;
      if (x(hi) >= tp) sell(p.left, `tp_${tp}x`, price, true);
      else if (x(lo) <= sl) sell(p.left, `sl_${scalp[2]}%`, price, true);
    } else if (p.plan === "C") {
      if (p.phase === "open" && x(lo) <= 0.6) sell(p.left, "emergency_-40%", price, true);
      else if (p.phase === "open" && x(hi) >= 2) { p.phase = "post_tp1"; sell(p.tokens * 0.5, "C_tp1_2x", price, false); }
      else if (p.phase === "post_tp1" && lo <= p.peak * 0.65) sell(p.left, "C_trailing_-35%", price, true);
    }
    if (!this.open.has(p.id)) return;
    this.d.db.prepare("UPDATE bnb_shadow_positions SET peak_price = ?, last_price = ?, last_at = ? WHERE id = ?").run(p.peak, price, now, p.id);
  }

  private close(p: Pos, now: number, reason: string) {
    const usd = this.d.bnbUsd() ?? 0;
    const net = (p.received - p.sizeBnb) * usd - p.txs * GAS_USD;
    this.d.db.prepare("UPDATE bnb_shadow_positions SET tokens_left = 0, received_bnb = ?, txs = ?, phase = 'closed', closed_at = ?, close_reason = ?, net_usd = ?, peak_price = ?, last_price = ?, last_at = ? WHERE id = ?")
      .run(p.received, p.txs, now, reason, net, p.peak, this.st.get(p.pair)?.price ?? null, now, p.id);
    this.open.delete(p.id); this.stats.closed++;
  }
}

function encodeTransfer(to: string, amount: bigint): `0x${string}` {
  return `0xa9059cbb${to.toLowerCase().replace(/^0x/, "").padStart(64, "0")}${amount.toString(16).padStart(64, "0")}`;
}
