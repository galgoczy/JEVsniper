import type { DB } from "../db/index.js";
import { log } from "../logger.js";
import { PUMP_AMM_PROGRAM, SOL_DEFAULT_WS, SOL_ZERO_PUBKEY, Reader } from "./pump.js";

/**
 * Solana / PumpSwap (graduáció utáni AMM) felvevő (2026-10-05). Forrás: pump-public-docs idl/pump_amm.json (commit cb188ce):
 * CreatePoolEvent, BuyEvent, SellEvent – a tranzakció-logban "Program data:" base64, 8 bájt diszkriminátor + Borsh.
 * Új megközelítés: nem az indulást, hanem a graduáció UTÁNI szakaszt mérjük (órás táv, ~2 000 graduáció/nap).
 *  - sol_amm_pools: a felvevő indulása óta létrejött poolok (CreatePoolEvent, VAGY a görbe-felvevő migrációs eseményéből – a hosszú
 *    migrációs tranzakció logja a logsSubscribe-ban csonkolódhat, a CreatePoolEvent kimaradhat; 10-05: 5 migrációból 1 pool látszott);
 *    csak SOL-quote-ot követünk;
 *  - sol_amm_trades: a pool első 6 órájának kötései (poolonként max. 3 000); ár = quote-tartalék / base-tartalék a kötés után;
 *  - sol_amm_snapshots: 60 / 300 / 900 / 3600 mp-nél (vételek, eladások, egyedi vevők, SOL be/ki, ár, pool SOL-tartaléka);
 *  - sol_amm_outcomes: az 5 perces árhoz mért csúcs/mélypont és a tartalék minimuma 24 órán át.
 */
export const WSOL_MINT = "So11111111111111111111111111111111111111112"; // SPL Token docs: wrapped SOL mint (kanonikus)
const DISC = {
  CreatePoolEvent: [177, 49, 12, 210, 160, 118, 167, 116],
  BuyEvent: [103, 244, 82, 31, 44, 245, 119, 119],
  SellEvent: [62, 47, 55, 10, 165, 3, 220, 42],
} as const;
const BY_KEY = new Map(Object.entries(DISC).map(([k, v]) => [v.join(","), k as keyof typeof DISC]));

export type AmmEvent =
  | { kind: "pool"; timestamp: number; creator: string; baseMint: string; quoteMint: string; baseDecimals: number; quoteDecimals: number; poolBase: bigint; poolQuote: bigint; pool: string; coinCreator: string; isMayhem: boolean }
  | { kind: "trade"; isBuy: boolean; timestamp: number; baseAmount: bigint; poolBase: bigint; poolQuote: bigint; quoteAmount: bigint; pool: string; user: string };

export function decodeAmmEvent(base64: string): AmmEvent | null {
  const b = Buffer.from(base64, "base64");
  if (b.length < 8) return null;
  const kind = BY_KEY.get(Array.from(b.subarray(0, 8)).join(","));
  if (!kind) return null;
  const r = new Reader(b);
  if (kind === "CreatePoolEvent") {
    const timestamp = Number(r.i64()); r.o += 2; // index u16
    const creator = r.pk(), baseMint = r.pk(), quoteMint = r.pk(), baseDecimals = r.u8(), quoteDecimals = r.u8();
    r.u64(); r.u64(); // base_amount_in, quote_amount_in
    const poolBase = r.u64(), poolQuote = r.u64();
    r.u64(); r.u64(); r.u64(); r.u8(); // minimum_liquidity, initial_liquidity, lp_token_amount_out, pool_bump
    const pool = r.pk(); r.pk(); r.pk(); r.pk(); // lp_mint, user_base_token_account, user_quote_token_account
    const coinCreator = r.pk(), isMayhem = r.bool();
    return { kind: "pool", timestamp, creator, baseMint, quoteMint, baseDecimals, quoteDecimals, poolBase, poolQuote, pool, coinCreator, isMayhem };
  }
  const isBuy = kind === "BuyEvent";
  const timestamp = Number(r.i64());
  const baseAmount = r.u64(); r.u64(); r.u64(); r.u64(); // base_amount_out/in, max/min quote, user reserves ×2
  const poolBase = r.u64(), poolQuote = r.u64(), quoteAmount = r.u64(); // pool reserves a kötés után; quote_amount_in / quote_amount_out
  r.u64(); r.u64(); r.u64(); r.u64(); r.u64(); r.u64(); // lp_fee_bps, lp_fee, protocol_fee_bps, protocol_fee, quote_with/without_lp_fee, user_quote_amount
  const pool = r.pk(), user = r.pk();
  return { kind: "trade", isBuy, timestamp, baseAmount, poolBase, poolQuote, quoteAmount, pool, user };
}
export function ammEventsFromLogs(logs: string[]): AmmEvent[] {
  const out: AmmEvent[] = [];
  for (const l of logs) if (l.startsWith("Program data: ")) { const e = decodeAmmEvent(l.slice(14)); if (e) out.push(e); }
  return out;
}

const SNAP_LATE_SEC = 90; // ennyivel az ablak után már nem írunk pillanatképet (az utólagos „60 mp-es” állapot hamis)
const WINDOWS = [60, 300, 900, 3600], REF_WINDOW = 300, TRADES_UNTIL_SEC = 6 * 3600, TRADES_CAP = 3000, OUTCOME_HOURS = 24;
interface Pool {
  pool: string; createdAt: number; baseDec: number; quoteDec: number;
  buys: number; sells: number; buyers: Set<string>; quoteIn: number; quoteOut: number; price: number; poolQuote: number; lastTradeAt: number; tradesStored: number;
  snapsDone: Set<number>; refPrice: number | null; maxX: number; minX: number; minPoolQuote: number;
}

export class SolAmmRecorder {
  private ws: WebSocket | null = null;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private pools = new Map<string, Pool>();
  private lastMigrateAt = 0;
  stats = { lateSnaps: 0, msgs: 0, pools: 0, fromMigrate: 0, trades: 0, snapshots: 0, reconnects: 0, errors: 0, tracked: 0 };
  constructor(private d: { db: DB; wsUrl?: string; now?: () => number }) {}
  private now() { return (this.d.now ?? Date.now)(); }

  start() { this.restore(); this.lastMigrateAt = this.now(); this.connect(); this.timer = setInterval(() => { try { this.adoptMigrations(); this.flush(); } catch (e) { this.stats.errors++; log.debug("SOL AMM flush hiba", { error: (e as Error).message.slice(0, 120) }); } }, 5_000); }
  stop() { this.stopped = true; if (this.timer) clearInterval(this.timer); this.ws?.close(); }

  restore() {
    const since = this.now() - OUTCOME_HOURS * 3600_000;
    const rows = this.d.db.prepare(`SELECT p.pool, p.created_at, o.ref_price, o.max_x, o.min_x, o.min_pool_quote, s.price p5 FROM sol_amm_pools p
      LEFT JOIN sol_amm_outcomes o ON o.pool = p.pool LEFT JOIN sol_amm_snapshots s ON s.pool = p.pool AND s.window_sec = ${REF_WINDOW} WHERE p.created_at > ? AND o.done_at IS NULL`).all(since) as Array<{ pool: string; created_at: number; ref_price: number | null; max_x: number | null; min_x: number | null; min_pool_quote: number | null; p5: number | null }>;
    for (const r of rows) if (!this.pools.has(r.pool)) this.pools.set(r.pool, { pool: r.pool, createdAt: r.created_at, baseDec: 6, quoteDec: 9, buys: 0, sells: 0, buyers: new Set(), quoteIn: 0, quoteOut: 0, price: 0, poolQuote: 0, lastTradeAt: 0, tradesStored: TRADES_CAP,
      snapsDone: new Set(WINDOWS), refPrice: r.ref_price ?? (r.p5 && r.p5 > 0 ? r.p5 : null), maxX: r.max_x ?? 1, minX: r.min_x ?? 1, minPoolQuote: r.min_pool_quote ?? Infinity });
    this.stats.tracked = this.pools.size;
  }

  private connect() {
    if (this.stopped) return;
    const ws = new WebSocket((this.d.wsUrl ?? SOL_DEFAULT_WS).split(",")[0]!.trim()); this.ws = ws;
    ws.onopen = () => ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "logsSubscribe", params: [{ mentions: [PUMP_AMM_PROGRAM] }, { commitment: "processed" }] }));
    ws.onmessage = (m) => { try { const d = JSON.parse(String(m.data)) as { params?: { result?: { value?: { logs?: string[]; err?: unknown; signature?: string } } } }; const v = d.params?.result?.value; if (!v?.logs || v.err) return; this.stats.msgs++; this.ingest(ammEventsFromLogs(v.logs), v.signature ?? null); } catch (e) { this.stats.errors++; log.debug("SOL AMM üzenet hiba", { error: (e as Error).message.slice(0, 120) }); } };
    ws.onerror = () => { this.stats.errors++; };
    ws.onclose = () => { if (this.stopped) return; this.stats.reconnects++; setTimeout(() => this.connect(), 3_000); };
  }

  /** A görbe-felvevő migrációs eseményeiből (sol_grads: pool + quote_mint) felvett poolok, ha a CreatePoolEvent nem jött át. */
  adoptMigrations() {
    const rows = this.d.db.prepare("SELECT mint, at, pool, quote_mint FROM sol_grads WHERE kind = 'migrate' AND at > ? AND pool IS NOT NULL ORDER BY at").all(this.lastMigrateAt) as Array<{ mint: string; at: number; pool: string; quote_mint: string | null }>;
    for (const r of rows) {
      this.lastMigrateAt = Math.max(this.lastMigrateAt, r.at);
      // a migrációs esemény quote_mint-je SOL-párnál a nulla pubkey (PUMP_PROGRAM_README: Pubkey::default()), a pool-eseményé a WSOL mint
      if (this.pools.has(r.pool) || (r.quote_mint !== null && r.quote_mint !== WSOL_MINT && r.quote_mint !== SOL_ZERO_PUBKEY)) continue;
      const ins = this.d.db.prepare("INSERT OR IGNORE INTO sol_amm_pools(pool, base_mint, quote_mint, quote_sol, creator, coin_creator, created_at, init_quote, init_base, mayhem) VALUES (?,?,?,1,NULL,NULL,?,NULL,NULL,NULL)").run(r.pool, r.mint, WSOL_MINT, r.at);
      if (ins.changes) { this.stats.pools++; this.stats.fromMigrate++; }
      this.pools.set(r.pool, { pool: r.pool, createdAt: r.at, baseDec: 6, quoteDec: 9, buys: 0, sells: 0, buyers: new Set(), quoteIn: 0, quoteOut: 0, price: 0, poolQuote: 0, lastTradeAt: 0, tradesStored: 0, snapsDone: new Set(), refPrice: null, maxX: 1, minX: 1, minPoolQuote: Infinity });
    }
  }

  ingest(events: AmmEvent[], signature: string | null) {
    const { db } = this.d;
    for (const e of events) {
      if (e.kind === "pool") {
        const quoteSol = e.quoteMint === WSOL_MINT;
        const r = db.prepare("INSERT OR IGNORE INTO sol_amm_pools(pool, base_mint, quote_mint, quote_sol, creator, coin_creator, created_at, init_quote, init_base, mayhem) VALUES (?,?,?,?,?,?,?,?,?,?)")
          .run(e.pool, e.baseMint, e.quoteMint, quoteSol ? 1 : 0, e.creator, e.coinCreator, e.timestamp * 1000, Number(e.poolQuote) / 10 ** e.quoteDecimals, Number(e.poolBase) / 10 ** e.baseDecimals, e.isMayhem ? 1 : 0);
        if (r.changes) this.stats.pools++;
        if (quoteSol && !this.pools.has(e.pool)) this.pools.set(e.pool, { pool: e.pool, createdAt: e.timestamp * 1000, baseDec: e.baseDecimals, quoteDec: e.quoteDecimals, buys: 0, sells: 0, buyers: new Set(), quoteIn: 0, quoteOut: 0,
          price: e.poolBase > 0n ? (Number(e.poolQuote) / 10 ** e.quoteDecimals) / (Number(e.poolBase) / 10 ** e.baseDecimals) : 0, poolQuote: Number(e.poolQuote) / 10 ** e.quoteDecimals, lastTradeAt: 0, tradesStored: 0, snapsDone: new Set(), refPrice: null, maxX: 1, minX: 1, minPoolQuote: Infinity });
      } else {
        const p = this.pools.get(e.pool); if (!p) continue;
        const q = Number(e.quoteAmount) / 10 ** p.quoteDec, at = e.timestamp * 1000;
        p.price = e.poolBase > 0n ? (Number(e.poolQuote) / 10 ** p.quoteDec) / (Number(e.poolBase) / 10 ** p.baseDec) : p.price;
        p.poolQuote = Number(e.poolQuote) / 10 ** p.quoteDec; p.lastTradeAt = at;
        if (e.isBuy) { p.buys++; p.quoteIn += q; p.buyers.add(e.user); } else { p.sells++; p.quoteOut += q; }
        if (p.refPrice) { const x = p.price / p.refPrice; p.maxX = Math.max(p.maxX, x); p.minX = Math.min(p.minX, x); p.minPoolQuote = Math.min(p.minPoolQuote, p.poolQuote); }
        if (at - p.createdAt <= TRADES_UNTIL_SEC * 1000 && p.tradesStored < TRADES_CAP) {
          db.prepare("INSERT INTO sol_amm_trades(pool, at, side, user, quote_sol, base_amount, price, pool_quote, signature) VALUES (?,?,?,?,?,?,?,?,?)")
            .run(e.pool, at, e.isBuy ? "buy" : "sell", e.user, q, Number(e.baseAmount) / 10 ** p.baseDec, p.price, p.poolQuote, signature);
          p.tradesStored++; this.stats.trades++;
        }
      }
    }
  }

  flush() {
    const { db } = this.d; const now = this.now();
    const insSnap = db.prepare("INSERT OR IGNORE INTO sol_amm_snapshots(pool, window_sec, at, buys, sells, unique_buyers, quote_in, quote_out, price, pool_quote, last_trade_age_sec) VALUES (?,?,?,?,?,?,?,?,?,?,?)");
    const upOut = db.prepare(`INSERT INTO sol_amm_outcomes(pool, ref_price, ref_at, max_x, min_x, min_pool_quote, done_at) VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(pool) DO UPDATE SET max_x = excluded.max_x, min_x = excluded.min_x, min_pool_quote = excluded.min_pool_quote, done_at = excluded.done_at`);
    const tx = db.transaction(() => {
      for (const p of this.pools.values()) {
        const age = (now - p.createdAt) / 1000;
        for (const w of WINDOWS) {
          if (age < w || p.snapsDone.has(w)) continue;
          p.snapsDone.add(w);
          if (age > w + SNAP_LATE_SEC) { this.stats.lateSnaps++; continue; } // késve észlelt entitás: utólagos pillanatkép nem íródik (2026-10-07)
          insSnap.run(p.pool, w, now, p.buys, p.sells, p.buyers.size, p.quoteIn, p.quoteOut, p.price, p.poolQuote, p.lastTradeAt ? Math.round((now - p.lastTradeAt) / 1000) : null); this.stats.snapshots++;
          if (w === REF_WINDOW) { p.refPrice = p.price > 0 ? p.price : null; p.maxX = 1; p.minX = 1; p.minPoolQuote = p.poolQuote; }
        }
        const done = age >= OUTCOME_HOURS * 3600;
        if (p.refPrice && (done || Math.round(age) % 300 < 5)) upOut.run(p.pool, p.refPrice, p.createdAt + REF_WINDOW * 1000, p.maxX, p.minX, Number.isFinite(p.minPoolQuote) ? p.minPoolQuote : null, done ? now : null);
        if (done) this.pools.delete(p.pool);
      }
    });
    tx(); this.stats.tracked = this.pools.size;
  }
}
