import { createPublicClient, http, decodeEventLog, parseAbi, getAddress, type PublicClient, type Log } from "viem";
import { bsc } from "viem/chains";
import type { DB } from "../db/index.js";
import { uniswapV2FactoryAbi } from "../abis/uniswap.js";
import { BNB, BNB_DEFAULT_RPC } from "./addresses.js";
import { log } from "../logger.js";

/**
 * BNB Chain / PancakeSwap v2 felvevő (2026-10-04). A PancakeSwap v2-n ~24 000 új pár/nap jön létre, ~60%-a WBNB-pár – DE ezek
 * túlnyomó része üres héj (a tokenszerződés a konstruktorában létrehozza, likviditás soha nem kerül bele; 10-04 minta: 17/18).
 * Ezért az indítás pillanata NEM a PairCreated, hanem az első likviditás-betétel: a friss WBNB-párokat („héjak”, 6 óráig)
 * 20 mp-enként egy getReserves-multicall ellenőrzi; ha WBNB került bele, a pár naplójából (a legutóbbi üres ellenőrzés
 * blokkjától) visszakeressük az első Sync-et – ez az indítás blokkja. (A publikus végpont cím nélküli getLogs-ot nem enged.)
 *  - bnb_pairs: minden valódi indítás (pár, token, indítási blokk, a likviditás-betétel tx küldője és címzettje);
 *  - bnb_pair_trades: az első 30 perc Swap-jai (vétel = WBNB be a párba), az ár a Sync-tartalékokból (WBNB / token, nyers arány);
 *  - bnb_pair_snapshots: 30/60/180/600/1800 mp: vételek, eladások, egyedi vevők (Swap.to), BNB be/ki, ár, WBNB-likviditás;
 *  - bnb_pair_outcomes: a 60 mp-es árhoz mért csúcs/mélypont és a WBNB-likviditás minimuma 24 órán át (5 percenként getReserves).
 * Az ár nyers tartalék-arány (nem skálázott tizedesekkel) – csak szorzóként (x) használjuk. Nem kereskedik.
 */
const PAIR_ABI = parseAbi([
  "event Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)",
  "event Sync(uint112 reserve0, uint112 reserve1)",
  "function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
]);
const SNAP_LATE_SEC = 90; // ennyivel az ablak után már nem írunk pillanatképet (az utólagos „60 mp-es” állapot hamis)
const WINDOWS = [30, 60, 180, 600, 1800];
// ADDR_BATCH: a publicnode BSC-végpont 2026-10-07 óta legfeljebb 9 címet fogad egy getLogs-ban (10+ → „Invalid parameters”)
const CHUNK = 100n, MAX_CATCHUP = 8000n, BLOCK_SEC = 0.45, ADDR_BATCH = 8, ADDR_PARALLEL = 4;
const TRADES_UNTIL_SEC = 1800, TRADES_CAP = 500, OUTCOME_HOURS = 24, OUTCOME_EVERY_MS = 5 * 60_000;
const SHELL_HOURS = 6, SHELL_CHECK_MS = 20_000;
interface Shell { pair: string; token: string; wbnbIs0: boolean; createdBlock: bigint; createdAt: number; zeroAtBlock: bigint }

interface Pair {
  pair: string; token: string; wbnbIs0: boolean; createdAt: number;
  buys: number; sells: number; buyers: Set<string>; bnbIn: number; bnbOut: number; price: number; liq: number; tradesStored: number;
  snapsDone: Set<number>; refPrice: number | null; maxX: number; minX: number; minLiq: number; peakLiq: number;
}

export class PancakeRecorder {
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  private c: PublicClient;
  private pairs = new Map<string, Pair>();
  private lastOutcome = 0;
  private shells = new Map<string, Shell>();
  private lastShellCheck = 0;
  private failStreak = 0;
  stats = { lateSnaps: 0, shells: 0, pairs: 0, trades: 0, snapshots: 0, errors: 0, tracked: 0, waiting: 0, lastBlock: 0n };
  constructor(private d: { db: DB; rpcUrl?: string; pollMs?: number; client?: PublicClient; now?: () => number; onEvent?: (e: import("./shadow.js").PairEvent) => void; onStep?: () => Promise<void> }) {
    this.c = d.client ?? (createPublicClient({ chain: bsc, transport: http((d.rpcUrl ?? BNB_DEFAULT_RPC).split(",")[0]!.trim(), { timeout: 15_000, retryCount: 1 }) }) as PublicClient);
  }
  private now() { return (this.d.now ?? Date.now)(); }
  get client() { return this.c; }
  start() { this.restore(); this.timer = setInterval(() => void this.tick(), this.d.pollMs ?? 5_000); void this.tick(); }

  /** Újraindítás után a 24 órán belüli indítások kimenet-követésének visszatöltése (a pillanatkép-ablakok késznek számítanak; a csúcs/mélypont/likviditás az 5 perces getReserves-ből folytatódik). */
  restore() {
    const since = this.now() - OUTCOME_HOURS * 3600_000;
    const rows = this.d.db.prepare(`SELECT p.pair, p.token, p.wbnb_is0, p.created_at, o.ref_price, o.max_x, o.min_x, o.min_liq_bnb, o.peak_liq_bnb, s.price p60, s.liq_bnb l60
      FROM bnb_pairs p LEFT JOIN bnb_pair_outcomes o ON o.pair = p.pair LEFT JOIN bnb_pair_snapshots s ON s.pair = p.pair AND s.window_sec = 60
      WHERE p.created_at > ? AND o.done_at IS NULL`).all(since) as Array<{ pair: string; token: string; wbnb_is0: number; created_at: number; ref_price: number | null; max_x: number | null; min_x: number | null; min_liq_bnb: number | null; peak_liq_bnb: number | null; p60: number | null; l60: number | null }>;
    for (const r of rows) {
      if (this.pairs.has(r.pair)) continue;
      const ref = r.ref_price ?? (r.p60 && r.p60 > 0 ? r.p60 : null);
      this.pairs.set(r.pair, { pair: r.pair, token: r.token, wbnbIs0: r.wbnb_is0 === 1, createdAt: r.created_at, buys: 0, sells: 0, buyers: new Set(), bnbIn: 0, bnbOut: 0, price: 0, liq: 0, tradesStored: TRADES_CAP,
        snapsDone: new Set(WINDOWS), refPrice: ref, maxX: r.max_x ?? 1, minX: r.min_x ?? 1, minLiq: r.min_liq_bnb ?? r.l60 ?? Infinity, peakLiq: r.peak_liq_bnb ?? r.l60 ?? 0 });
    }
    this.stats.tracked = this.pairs.size;
  }
  stop() { if (this.timer) clearInterval(this.timer); }

  async tick(): Promise<void> {
    if (this.busy) return; this.busy = true;
    const { db } = this.d;
    try {
      const head = await this.c.getBlockNumber();
      const saved = (db.prepare("SELECT value FROM meta WHERE key = 'pcs_last_block'").get() as { value: string } | undefined)?.value;
      let from = saved ? BigInt(saved) + 1n : head;
      if (head - from > MAX_CATCHUP) from = head - MAX_CATCHUP;
      const nowMs = this.now();
      for (let f = from; f <= head; f += CHUNK) {
        const to = f + CHUNK - 1n > head ? head : f + CHUNK - 1n;
        const created = await this.c.getLogs({ address: BNB.pancakeV2Factory, event: uniswapV2FactoryAbi[0], fromBlock: f, toBlock: to });
        await this.onPairsCreated(created, head, nowMs);
        const young = [...this.pairs.values()].filter((p) => nowMs - p.createdAt <= TRADES_UNTIL_SEC * 1000 + 60_000).map((p) => p.pair as `0x${string}`);
        const batches: Array<`0x${string}`[]> = [];
        for (let i = 0; i < young.length; i += ADDR_BATCH) batches.push(young.slice(i, i + ADDR_BATCH));
        const all: Log[] = [];
        for (let i = 0; i < batches.length; i += ADDR_PARALLEL)
          for (const logs of await Promise.all(batches.slice(i, i + ADDR_PARALLEL).map((b) => this.c.getLogs({ address: b, events: PAIR_ABI.filter((x) => x.type === "event"), fromBlock: f, toBlock: to })))) all.push(...logs);
        all.sort((a, b) => Number((a.blockNumber ?? 0n) - (b.blockNumber ?? 0n)) || (a.logIndex ?? 0) - (b.logIndex ?? 0)); // a Sync→Swap sorrend számít
        this.ingestPairLogs(all, head, nowMs);
        db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES ('pcs_last_block', ?)").run(to.toString());
        this.stats.lastBlock = to;
        // 2026-10-07: az árnyékkarok ne a (visszaolvasáskor akár 20 perces) kör végén lépjenek, hanem minden adag után – csak a láncfej közelében
        if (this.d.onStep && head - to < 20n) await this.d.onStep().catch((e) => log.debug("BNB árnyék hiba", { error: (e as Error).message.slice(0, 160) }));
      }
      if (nowMs - this.lastShellCheck >= SHELL_CHECK_MS) { this.lastShellCheck = nowMs; await this.checkShells(head, nowMs); }
      this.flush();
      if (nowMs - this.lastOutcome >= OUTCOME_EVERY_MS) { this.lastOutcome = nowMs; await this.refreshOutcomes(); }
      if (this.d.onStep) await this.d.onStep().catch((e) => log.debug("BNB árnyék hiba", { error: (e as Error).message.slice(0, 160) }));
      this.failStreak = 0;
    } catch (e) {
      this.stats.errors++; this.failStreak++;
      // 2026-10-07: a csendes elakadás (pl. RPC-korlát) látszódjon: 12 egymás utáni hibás kör (~1 perc) után figyelmeztetés, utána 10 percenként
      if (this.failStreak === 12 || (this.failStreak > 12 && this.failStreak % 120 === 0)) log.warn("PancakeSwap felvevő elakadt", { hibák_egymás_után: this.failStreak, error: (e as Error).message.slice(0, 160) });
      else log.debug("PancakeSwap felvevő hiba", { error: (e as Error).message.slice(0, 160) });
    }
    finally { this.busy = false; }
  }

  private atOf(head: bigint, nowMs: number, b: bigint) { return Math.round(nowMs - Number(head - b) * BLOCK_SEC * 1000); }

  /** Új WBNB-párok nyilvántartása „héjként” (még nincs likviditás); indításnak csak az első likviditás-betétel számít. */
  async onPairsCreated(logs: Array<Log & { args?: Record<string, unknown> }>, head: bigint, nowMs: number) {
    const wbnb = BNB.wbnb.toLowerCase();
    for (const l of logs) {
      let a: Record<string, unknown>;
      try { a = decodeEventLog({ abi: uniswapV2FactoryAbi, data: l.data, topics: l.topics }).args as Record<string, unknown>; } catch { continue; }
      const t0 = String(a.token0).toLowerCase(), t1 = String(a.token1).toLowerCase(), pair = String(a.pair).toLowerCase();
      if (t0 !== wbnb && t1 !== wbnb) continue;
      const b = l.blockNumber ?? head;
      if (!this.shells.has(pair) && !this.pairs.has(pair)) { this.shells.set(pair, { pair, token: t0 === wbnb ? t1 : t0, wbnbIs0: t0 === wbnb, createdBlock: b, createdAt: this.atOf(head, nowMs, b), zeroAtBlock: b > 0n ? b - 1n : 0n }); this.stats.shells++; }
    }
    this.stats.waiting = this.shells.size;
  }

  /** Héjak: van-e már WBNB a párban? Ha igen, az első Sync blokkja az indítás; onnan a kötések is visszatöltődnek. */
  async checkShells(head: bigint, nowMs: number) {
    for (const [k, sh] of this.shells) if (nowMs - sh.createdAt > SHELL_HOURS * 3600_000) this.shells.delete(k);
    const list = [...this.shells.values()];
    for (let i = 0; i < list.length; i += 400) {
      const batch = list.slice(i, i + 400);
      const res = await this.c.multicall({ allowFailure: true, contracts: batch.map((p) => ({ address: getAddress(p.pair), abi: PAIR_ABI, functionName: "getReserves" as const })) }).catch(() => null);
      if (!res) continue;
      for (let k = 0; k < batch.length; k++) {
        const sh = batch[k]!, r = res[k]; if (!r || r.status !== "success") continue;
        const [r0, r1] = r.result as readonly [bigint, bigint, number];
        if ((sh.wbnbIs0 ? r0 : r1) === 0n) { sh.zeroAtBlock = head; continue; }
        await this.launch(sh, head, nowMs).catch((e) => log.debug("PancakeSwap indítás-visszakeresés hiba", { error: (e as Error).message.slice(0, 120) }));
      }
    }
    this.stats.waiting = this.shells.size;
  }

  private async launch(sh: Shell, head: bigint, nowMs: number) {
    const from = sh.zeroAtBlock + 1n > head - MAX_CATCHUP ? sh.zeroAtBlock + 1n : head - MAX_CATCHUP;
    const logs: Log[] = [];
    for (let f = from; f <= head; f += CHUNK) logs.push(...await this.c.getLogs({ address: getAddress(sh.pair), events: PAIR_ABI.filter((x) => x.type === "event"), fromBlock: f, toBlock: f + CHUNK - 1n > head ? head : f + CHUNK - 1n }));
    const first = logs.find((l) => { try { const d = decodeEventLog({ abi: PAIR_ABI, data: l.data, topics: l.topics }); return d.eventName === "Sync" && ((sh.wbnbIs0 ? d.args.reserve0 : d.args.reserve1) as bigint) > 0n; } catch { return false; } });
    this.shells.delete(sh.pair);
    if (!first) return;
    const lb = first.blockNumber ?? head, at = this.atOf(head, nowMs, lb);
    const tx = first.transactionHash ? await this.c.getTransaction({ hash: first.transactionHash }).catch(() => null) : null;
    const r = this.d.db.prepare("INSERT OR IGNORE INTO bnb_pairs(pair, token, wbnb_is0, created_block, created_at, creator, tx_to, pair_created_block) VALUES (?,?,?,?,?,?,?,?)")
      .run(sh.pair, sh.token, sh.wbnbIs0 ? 1 : 0, Number(lb), at, tx?.from?.toLowerCase() ?? null, tx?.to?.toLowerCase() ?? null, Number(sh.createdBlock));
    if (r.changes) this.stats.pairs++;
    this.pairs.set(sh.pair, { pair: sh.pair, token: sh.token, wbnbIs0: sh.wbnbIs0, createdAt: at, buys: 0, sells: 0, buyers: new Set(), bnbIn: 0, bnbOut: 0, price: 0, liq: 0, tradesStored: 0,
      snapsDone: new Set(), refPrice: null, maxX: 1, minX: 1, minLiq: Infinity, peakLiq: 0 });
    // a likviditás-betétel óta eltelt kötések (a pillanatképek ezekből is számolnak)
    this.ingestPairLogs(logs.filter((l) => (l.blockNumber ?? 0n) >= lb), head, nowMs);
  }

  /** Swap és Sync események feldolgozása (tesztelhető). Vétel = WBNB megy a párba; az ár a legutóbbi Sync tartalékaiból. */
  ingestPairLogs(logs: Array<Log>, head: bigint, nowMs: number) {
    const ins = this.d.db.prepare("INSERT OR IGNORE INTO bnb_pair_trades(pair, tx, log_index, block, at, side, to_addr, bnb, price) VALUES (?,?,?,?,?,?,?,?,?)");
    for (const l of logs) {
      const p = this.pairs.get(l.address.toLowerCase()); if (!p) continue;
      let d; try { d = decodeEventLog({ abi: PAIR_ABI, data: l.data, topics: l.topics }); } catch { continue; }
      const a = d.args as Record<string, bigint | string>;
      if (d.eventName === "Sync") {
        const rW = Number(p.wbnbIs0 ? a.reserve0 : a.reserve1), rT = Number(p.wbnbIs0 ? a.reserve1 : a.reserve0);
        p.liq = rW / 1e18; p.peakLiq = Math.max(p.peakLiq, p.liq); if (rT > 0) p.price = rW / rT;
        if (p.refPrice && p.price > 0) { const x = p.price / p.refPrice; p.maxX = Math.max(p.maxX, x); p.minX = Math.min(p.minX, x); }
        if (p.refPrice) p.minLiq = Math.min(p.minLiq, p.liq);
      } else {
        const wIn = Number(p.wbnbIs0 ? a.amount0In : a.amount1In) / 1e18, wOut = Number(p.wbnbIs0 ? a.amount0Out : a.amount1Out) / 1e18;
        const isBuy = wIn > 0 && wOut === 0, at = this.atOf(head, nowMs, l.blockNumber ?? head);
        if (isBuy) { p.buys++; p.bnbIn += wIn; p.buyers.add(String(a.to).toLowerCase()); } else { p.sells++; p.bnbOut += wOut; }
        this.d.onEvent?.({ pair: p.pair, token: p.token, createdAt: p.createdAt, at, kind: "trade", side: isBuy ? "buy" : "sell", bnb: isBuy ? wIn : wOut, to: String(a.to), price: p.price, liq: p.liq });
        if (at - p.createdAt <= TRADES_UNTIL_SEC * 1000 && p.tradesStored < TRADES_CAP) {
          if (ins.run(p.pair, l.transactionHash, l.logIndex ?? 0, Number(l.blockNumber ?? 0n), at, isBuy ? "buy" : "sell", String(a.to).toLowerCase(), isBuy ? wIn : wOut, p.price).changes) { p.tradesStored++; this.stats.trades++; }
        }
      }
    }
  }

  flush() {
    const { db } = this.d; const now = this.now();
    const insSnap = db.prepare(`INSERT OR IGNORE INTO bnb_pair_snapshots(pair, window_sec, at, buys, sells, unique_buyers, bnb_in, bnb_out, price, liq_bnb) VALUES (?,?,?,?,?,?,?,?,?,?)`);
    const tx = db.transaction(() => {
      for (const p of this.pairs.values()) {
        const age = (now - p.createdAt) / 1000;
        for (const w of WINDOWS) {
          if (age < w || p.snapsDone.has(w)) continue;
          p.snapsDone.add(w);
          if (age > w + SNAP_LATE_SEC) { this.stats.lateSnaps++; continue; } // késve észlelt entitás: utólagos pillanatkép nem íródik (2026-10-07)
          insSnap.run(p.pair, w, now, p.buys, p.sells, p.buyers.size, p.bnbIn, p.bnbOut, p.price, p.liq); this.stats.snapshots++;
          if (w === 60) { p.refPrice = p.price > 0 ? p.price : null; p.maxX = 1; p.minX = 1; p.minLiq = p.liq; }
        }
        if (age >= OUTCOME_HOURS * 3600) { this.writeOutcome(p, now); this.pairs.delete(p.pair); }
      }
    });
    tx(); this.stats.tracked = this.pairs.size;
  }

  private writeOutcome(p: Pair, now: number, done = true) {
    if (!p.refPrice) return;
    this.d.db.prepare(`INSERT INTO bnb_pair_outcomes(pair, ref_price, ref_at, max_x, min_x, min_liq_bnb, peak_liq_bnb, done_at) VALUES (?,?,?,?,?,?,?,?)
      ON CONFLICT(pair) DO UPDATE SET max_x = excluded.max_x, min_x = excluded.min_x, min_liq_bnb = excluded.min_liq_bnb, peak_liq_bnb = excluded.peak_liq_bnb, done_at = excluded.done_at`)
      .run(p.pair, p.refPrice, p.createdAt + 60_000, p.maxX, p.minX, Number.isFinite(p.minLiq) ? p.minLiq : null, p.peakLiq, done ? now : null);
  }

  /** 30 perc után a párok tartalékait 5 percenként egy multicall-lal frissíti (csúcs, mélypont, likviditás-kihúzás). */
  private async refreshOutcomes() {
    const old = [...this.pairs.values()].filter((p) => p.refPrice && this.now() - p.createdAt > TRADES_UNTIL_SEC * 1000);
    for (let i = 0; i < old.length; i += 400) {
      const batch = old.slice(i, i + 400);
      const res = await this.c.multicall({ allowFailure: true, contracts: batch.map((p) => ({ address: getAddress(p.pair), abi: PAIR_ABI, functionName: "getReserves" as const })) }).catch(() => null);
      if (!res) continue;
      batch.forEach((p, k) => {
        const r = res[k]; if (!r || r.status !== "success") return;
        const [r0, r1] = r.result as readonly [bigint, bigint, number];
        const rW = Number(p.wbnbIs0 ? r0 : r1), rT = Number(p.wbnbIs0 ? r1 : r0);
        p.liq = rW / 1e18; p.minLiq = Math.min(p.minLiq, p.liq); p.peakLiq = Math.max(p.peakLiq, p.liq);
        if (rT > 0 && p.refPrice) { p.price = rW / rT; const x = p.price / p.refPrice; p.maxX = Math.max(p.maxX, x); p.minX = Math.min(p.minX, x); }
        if (rT > 0) this.d.onEvent?.({ pair: p.pair, token: p.token, createdAt: p.createdAt, at: this.now(), kind: "reserve", price: rW / rT, liq: p.liq });
        this.writeOutcome(p, this.now(), false);
      });
    }
  }
}
