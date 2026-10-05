import type { DB } from "../db/index.js";
import { log } from "../logger.js";
import { PUMP_PROGRAM, SOL_DEFAULT_WS, SOL_ZERO_PUBKEY, curvePrice, curveProgressPct, eventsFromLogs, type PumpEvent } from "./pump.js";

/**
 * Solana / Pump.fun felvevő (2026-10-04, első lépés). A publikus websocketen (logsSubscribe, a Pump programot említő tranzakciók)
 * MINDEN indítást, kötést, görbe-teljesülést és migrációt lát; a napi ~3,5 millió kötés miatt nem minden kötést ment, hanem:
 *  - sol_tokens: minden új token (CreateEvent);
 *  - sol_trades: a felvevő indulása óta született tokenek kötései az első 30 percben (tokenenként legfeljebb 500);
 *  - sol_snapshots: tokenenként 30/60/180/600/1800 mp-nél a belépés-pillanat jellemzői (vevők, forgalom, ár, görbe-haladás, készítő eladott-e);
 *  - sol_outcomes: a 60 mp-es árhoz mért csúcs/mélypont 24 órán át, görbe-teljesülés és migráció ideje.
 * Nem kereskedik és árnyékpozíciót sem nyit. A Pump-görbe ára = virtuális SOL / virtuális token (PUMP_PROGRAM_README.md).
 */
export interface SolRecorderDeps { db: DB; wsUrl?: string; now?: () => number; fetchFn?: typeof fetch }

const WINDOWS = [30, 60, 180, 600, 1800];
const TRADES_UNTIL_SEC = 1800, TRADES_CAP = 500, OUTCOME_HOURS = 24;
// Túlélők (2026-10-05): ha a 30 perces pillanatképnél a görbe-haladás ≥ SURVIVOR_MIN_PROGRESS, a kötéseket 6 óráig (vagy a
// teljesülésig) tovább mentjük (nagyobb kerettel), és a kimenetet a 30 perces árhoz képest is követjük (max_x30 / min_x30) –
// a 24 órás durva kép szerint a félig feltöltött, túlélő görbéknél a 30 perc UTÁN van a nagy mozgás.
const SURVIVOR_MIN_PROGRESS = 10, SURVIVOR_UNTIL_SEC = 6 * 3600, SURVIVOR_TRADES_CAP = 3000;
const REF_WINDOW = 60;

interface Track {
  mint: string; createdAt: number; creator: string; symbol: string; quoteSol: boolean;
  buys: number; sells: number; buyers: Set<string>; solIn: number; solOut: number; largestBuySol: number; creatorSold: boolean; creatorBought: boolean;
  price: number; progress: number; lastTradeAt: number; tradesStored: number;
  snapsDone: Set<number>; refPrice: number | null; maxX: number; minX: number; completeAt: number | null; migratedAt: number | null; outcomeWritten: boolean;
  survivor: boolean; ref30: number | null; maxX30: number; minX30: number;
}

export class SolRecorder {
  private ws: WebSocket | null = null;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private tracks = new Map<string, Track>();
  private lastPx = 0;
  stats = { msgs: 0, tokens: 0, trades: 0, snapshots: 0, completes: 0, migrations: 0, reconnects: 0, errors: 0, tracked: 0, survivors: 0 };
  constructor(private d: SolRecorderDeps) {}
  private now() { return (this.d.now ?? Date.now)(); }

  start() {
    this.restore();
    this.connect();
    this.timer = setInterval(() => { try { this.flush(); } catch (e) { this.stats.errors++; log.debug("SOL felvevő flush hiba", { error: (e as Error).message.slice(0, 120) }); } void this.refreshSolUsd(); }, 5_000);
  }
  stop() { this.stopped = true; if (this.timer) clearInterval(this.timer); this.ws?.close(); }

  /**
   * Újraindítás után a 24 órán belül indult tokenek kimenet-követésének visszatöltése (2026-10-04: újraindításkor a memóriában
   * tartott követés elveszett, a 24 órás kimenetek nem zárultak le). A pillanatkép-ablakok mind „késznek” számítanak: a
   * kiesett időszak kötései hiányoznak, a hiányos számlálással felvett pillanatkép torz lenne. Csak a csúcs/mélypont/teljesülés
   * követése folytatódik (a websocket-kötésekből).
   */
  restore() {
    const { db } = this.d; const since = this.now() - OUTCOME_HOURS * 3600_000;
    const rows = db.prepare(`SELECT t.mint, t.created_at, t.creator, t.symbol, t.quote_sol, o.ref_price, o.max_x, o.min_x, o.complete_at, o.migrated_at, o.ref30_price, o.max_x30, o.min_x30, s.price p60
      FROM sol_tokens t LEFT JOIN sol_outcomes o ON o.mint = t.mint LEFT JOIN sol_snapshots s ON s.mint = t.mint AND s.window_sec = ${REF_WINDOW}
      WHERE t.created_at > ? AND (o.done_at IS NULL)`).all(since) as Array<{ mint: string; created_at: number; creator: string; symbol: string; quote_sol: number; ref_price: number | null; max_x: number | null; min_x: number | null; complete_at: number | null; migrated_at: number | null; p60: number | null; ref30_price: number | null; max_x30: number | null; min_x30: number | null }>;
    for (const r of rows) {
      if (this.tracks.has(r.mint)) continue;
      const ref = r.ref_price ?? (r.p60 && r.p60 > 0 ? r.p60 : null);
      this.tracks.set(r.mint, { mint: r.mint, createdAt: r.created_at, creator: r.creator, symbol: r.symbol, quoteSol: r.quote_sol === 1, buys: 0, sells: 0, buyers: new Set(), solIn: 0, solOut: 0, largestBuySol: 0, creatorSold: false, creatorBought: false,
        price: 0, progress: 0, lastTradeAt: 0, tradesStored: TRADES_CAP, snapsDone: new Set(WINDOWS), refPrice: ref, maxX: r.max_x ?? 1, minX: r.min_x ?? 1, completeAt: r.complete_at, migratedAt: r.migrated_at, outcomeWritten: false, survivor: false, ref30: r.ref30_price ?? null, maxX30: r.max_x30 ?? 1, minX30: r.min_x30 ?? 1 });
    }
    this.stats.tracked = this.tracks.size;
    if (rows.length) log.info(`SOL felvevő: ${this.tracks.size} token kimenet-követése visszatöltve`);
  }

  private connect() {
    if (this.stopped) return;
    const url = (this.d.wsUrl ?? SOL_DEFAULT_WS).split(",")[0]!.trim();
    const ws = new WebSocket(url); this.ws = ws;
    ws.onopen = () => ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "logsSubscribe", params: [{ mentions: [PUMP_PROGRAM] }, { commitment: "processed" }] }));
    ws.onmessage = (m) => { try { this.onMessage(String(m.data)); } catch (e) { this.stats.errors++; log.debug("SOL üzenet hiba", { error: (e as Error).message.slice(0, 120) }); } };
    ws.onerror = () => { this.stats.errors++; };
    ws.onclose = () => { if (this.stopped) return; this.stats.reconnects++; setTimeout(() => this.connect(), 3_000); };
  }

  private onMessage(raw: string) {
    const d = JSON.parse(raw) as { params?: { result?: { value?: { logs?: string[]; err?: unknown; signature?: string } } } };
    const v = d.params?.result?.value; if (!v?.logs || v.err) return;
    this.stats.msgs++;
    this.ingest(eventsFromLogs(v.logs), v.signature ?? null);
  }

  /** Dekódolt események feldolgozása (tesztelhető belépési pont). */
  ingest(events: PumpEvent[], signature: string | null) {
    const { db } = this.d;
    for (const e of events) {
      if (e.kind === "create") {
        const quoteSol = e.quoteMint === SOL_ZERO_PUBKEY;
        const r = db.prepare(`INSERT OR IGNORE INTO sol_tokens(mint, symbol, name, creator, user, created_at, quote_sol, quote_mint, mayhem, holder_reward, creator_fee_bps, bonding_curve)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(e.mint, e.symbol.slice(0, 40), e.name.slice(0, 80), e.creator, e.user, e.timestamp * 1000, quoteSol ? 1 : 0, e.quoteMint, e.isMayhemMode ? 1 : 0, e.isHolderReward ? 1 : 0, Number(e.creatorFeeBps), e.bondingCurve);
        if (r.changes) this.stats.tokens++;
        if (!this.tracks.has(e.mint)) this.tracks.set(e.mint, { mint: e.mint, createdAt: e.timestamp * 1000, creator: e.creator, symbol: e.symbol, quoteSol, buys: 0, sells: 0, buyers: new Set(), solIn: 0, solOut: 0, largestBuySol: 0, creatorSold: false, creatorBought: false,
          price: curvePrice(e.virtualSolReserves, e.virtualTokenReserves), progress: 0, lastTradeAt: 0, tradesStored: 0, snapsDone: new Set(), refPrice: null, maxX: 1, minX: 1, completeAt: null, migratedAt: null, outcomeWritten: false, survivor: false, ref30: null, maxX30: 1, minX30: 1 });
      } else if (e.kind === "trade") {
        const t = this.tracks.get(e.mint); if (!t) continue; // csak az indulás óta született tokenek
        const sol = Number(e.solAmount) / 1e9, at = e.timestamp * 1000;
        if (e.isBuy) { t.buys++; t.solIn += sol; if (e.user !== t.creator) t.buyers.add(e.user); else t.creatorBought = true; t.largestBuySol = Math.max(t.largestBuySol, sol); }
        else { t.sells++; t.solOut += sol; if (e.user === t.creator) t.creatorSold = true; }
        t.price = curvePrice(e.virtualSolReserves, e.virtualTokenReserves); t.progress = curveProgressPct(e.realTokenReserves); t.lastTradeAt = at;
        if (t.refPrice) { const x = t.price / t.refPrice; t.maxX = Math.max(t.maxX, x); t.minX = Math.min(t.minX, x); }
        if (t.ref30) { const x = t.price / t.ref30; t.maxX30 = Math.max(t.maxX30, x); t.minX30 = Math.min(t.minX30, x); }
        const age = at - t.createdAt;
        const keep = age <= TRADES_UNTIL_SEC * 1000 ? t.tradesStored < TRADES_CAP : (t.survivor && !t.completeAt && age <= SURVIVOR_UNTIL_SEC * 1000 && t.tradesStored < SURVIVOR_TRADES_CAP);
        if (keep) {
          db.prepare("INSERT INTO sol_trades(mint, at, side, user, sol, tokens, price, progress_pct, signature) VALUES (?,?,?,?,?,?,?,?,?)")
            .run(e.mint, at, e.isBuy ? "buy" : "sell", e.user, sol, Number(e.tokenAmount) / 1e6, t.price, t.progress, signature);
          t.tradesStored++; this.stats.trades++;
        }
      } else if (e.kind === "complete") {
        this.stats.completes++;
        db.prepare("INSERT OR IGNORE INTO sol_grads(mint, kind, at, pool) VALUES (?,?,?,NULL)").run(e.mint, "complete", e.timestamp * 1000);
        const t = this.tracks.get(e.mint); if (t) t.completeAt = e.timestamp * 1000;
      } else if (e.kind === "migrate") {
        this.stats.migrations++;
        db.prepare("INSERT OR IGNORE INTO sol_grads(mint, kind, at, pool, quote_mint) VALUES (?,?,?,?,?)").run(e.mint, "migrate", e.timestamp * 1000, e.pool, e.quoteMint);
        const t = this.tracks.get(e.mint); if (t) t.migratedAt = e.timestamp * 1000;
      }
    }
  }

  /** Esedékes pillanatképek és kimenetek írása; 24 óra után a token kikerül a memóriából. */
  flush() {
    const { db } = this.d; const now = this.now();
    const insSnap = db.prepare(`INSERT OR IGNORE INTO sol_snapshots(mint, window_sec, at, buys, sells, unique_buyers, sol_in, sol_out, largest_buy_sol, price, progress_pct, creator_sold, creator_bought, last_trade_age_sec)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    const upOut = db.prepare(`INSERT INTO sol_outcomes(mint, ref_price, ref_at, max_x, min_x, complete_at, migrated_at, done_at, ref30_price, max_x30, min_x30) VALUES (?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(mint) DO UPDATE SET max_x = excluded.max_x, min_x = excluded.min_x, complete_at = excluded.complete_at, migrated_at = excluded.migrated_at, done_at = excluded.done_at, ref30_price = excluded.ref30_price, max_x30 = excluded.max_x30, min_x30 = excluded.min_x30`);
    const tx = db.transaction(() => {
      for (const t of this.tracks.values()) {
        const age = (now - t.createdAt) / 1000;
        for (const w of WINDOWS) {
          if (age < w || t.snapsDone.has(w)) continue;
          t.snapsDone.add(w);
          insSnap.run(t.mint, w, now, t.buys, t.sells, t.buyers.size, t.solIn, t.solOut, t.largestBuySol, t.price, t.progress, t.creatorSold ? 1 : 0, t.creatorBought ? 1 : 0, t.lastTradeAt ? Math.round((now - t.lastTradeAt) / 1000) : null);
          this.stats.snapshots++;
          if (w === REF_WINDOW) { t.refPrice = t.price > 0 ? t.price : null; t.maxX = 1; t.minX = 1; }
          if (w === 1800) { t.ref30 = t.price > 0 ? t.price : null; t.maxX30 = 1; t.minX30 = 1; if (t.progress >= SURVIVOR_MIN_PROGRESS && !t.completeAt) { t.survivor = true; this.stats.survivors++; } }
        }
        const done = age >= OUTCOME_HOURS * 3600;
        if (t.refPrice && (done || t.completeAt || t.migratedAt || Math.round(age) % 300 < 5)) upOut.run(t.mint, t.refPrice, t.createdAt + REF_WINDOW * 1000, t.maxX, t.minX, t.completeAt, t.migratedAt, done ? now : null, t.ref30, t.maxX30, t.minX30);
        if (done) this.tracks.delete(t.mint);
      }
    });
    tx();
    this.stats.tracked = this.tracks.size;
  }

  /** SOL/USD a Coinbase Exchange nyilvános tickeréből (ugyanaz a hivatalos API, mint a listázás-figyelőnél), percenként a meta táblába. */
  private async refreshSolUsd() {
    if (this.now() - this.lastPx < 60_000) return; this.lastPx = this.now();
    try {
      const f = this.d.fetchFn ?? fetch;
      const r = await f("https://api.exchange.coinbase.com/products/SOL-USD/ticker", { headers: { accept: "application/json", "user-agent": "jev-sniper/0.1" }, signal: AbortSignal.timeout(10_000) });
      const j = (await r.json()) as { price?: string };
      const px = Number(j.price); if (!(px > 0)) return;
      const put = this.d.db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)");
      put.run("sol_usd", String(px)); put.run("sol_usd_at", String(this.now()));
    } catch (e) { log.debug("SOL/USD hiba", { error: (e as Error).message.slice(0, 100) }); }
  }
}
