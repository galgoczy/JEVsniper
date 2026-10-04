import { createPublicClient, http, decodeEventLog, parseAbi, getAddress, type PublicClient, type Log } from "viem";
import { bsc } from "viem/chains";
import type { DB } from "../db/index.js";
import { uniswapV2FactoryAbi } from "../abis/uniswap.js";
import { BNB, BNB_DEFAULT_RPC } from "./addresses.js";
import { log } from "../logger.js";

/**
 * BNB Chain / PancakeSwap v2 felvevő (2026-10-04). 10-04-i mérés: a BNB-memeforgalom nagy része NEM a Four.meme-en,
 * hanem közvetlenül a PancakeSwap v2-n indul (~24 000 új pár/nap, ~60%-a WBNB-pár) – ez a Base/Uniswap-indítások megfelelője.
 *  - bnb_pairs: minden új WBNB-pár (pár, token, blokk, létrehozó tx küldője);
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
const WINDOWS = [30, 60, 180, 600, 1800];
const CHUNK = 100n, MAX_CATCHUP = 8000n, BLOCK_SEC = 0.45, ADDR_BATCH = 100;
const TRADES_UNTIL_SEC = 1800, TRADES_CAP = 500, OUTCOME_HOURS = 24, OUTCOME_EVERY_MS = 5 * 60_000;

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
  stats = { pairs: 0, trades: 0, snapshots: 0, errors: 0, tracked: 0, lastBlock: 0n };
  constructor(private d: { db: DB; rpcUrl?: string; pollMs?: number; client?: PublicClient; now?: () => number }) {
    this.c = d.client ?? (createPublicClient({ chain: bsc, transport: http((d.rpcUrl ?? BNB_DEFAULT_RPC).split(",")[0]!.trim(), { timeout: 15_000, retryCount: 1 }) }) as PublicClient);
  }
  private now() { return (this.d.now ?? Date.now)(); }
  start() { this.timer = setInterval(() => void this.tick(), this.d.pollMs ?? 5_000); void this.tick(); }
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
        for (let i = 0; i < young.length; i += ADDR_BATCH) {
          const logs = await this.c.getLogs({ address: young.slice(i, i + ADDR_BATCH), events: PAIR_ABI.filter((x) => x.type === "event"), fromBlock: f, toBlock: to });
          this.ingestPairLogs(logs, head, nowMs);
        }
        db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES ('pcs_last_block', ?)").run(to.toString());
        this.stats.lastBlock = to;
      }
      this.flush();
      if (nowMs - this.lastOutcome >= OUTCOME_EVERY_MS) { this.lastOutcome = nowMs; await this.refreshOutcomes(); }
    } catch (e) { this.stats.errors++; log.debug("PancakeSwap felvevő hiba", { error: (e as Error).message.slice(0, 160) }); }
    finally { this.busy = false; }
  }

  private atOf(head: bigint, nowMs: number, b: bigint) { return Math.round(nowMs - Number(head - b) * BLOCK_SEC * 1000); }

  async onPairsCreated(logs: Array<Log & { args?: Record<string, unknown> }>, head: bigint, nowMs: number) {
    const wbnb = BNB.wbnb.toLowerCase();
    for (const l of logs) {
      let a: Record<string, unknown>;
      try { a = decodeEventLog({ abi: uniswapV2FactoryAbi, data: l.data, topics: l.topics }).args as Record<string, unknown>; } catch { continue; }
      const t0 = String(a.token0).toLowerCase(), t1 = String(a.token1).toLowerCase(), pair = String(a.pair).toLowerCase();
      if (t0 !== wbnb && t1 !== wbnb) continue;
      const token = t0 === wbnb ? t1 : t0, at = this.atOf(head, nowMs, l.blockNumber ?? head);
      const tx = l.transactionHash ? await this.c.getTransaction({ hash: l.transactionHash }).catch(() => null) : null;
      const r = this.d.db.prepare("INSERT OR IGNORE INTO bnb_pairs(pair, token, wbnb_is0, created_block, created_at, creator, tx_to) VALUES (?,?,?,?,?,?,?)")
        .run(pair, token, t0 === wbnb ? 1 : 0, Number(l.blockNumber ?? 0n), at, tx?.from?.toLowerCase() ?? null, tx?.to?.toLowerCase() ?? null);
      if (r.changes) this.stats.pairs++;
      if (!this.pairs.has(pair)) this.pairs.set(pair, { pair, token, wbnbIs0: t0 === wbnb, createdAt: at, buys: 0, sells: 0, buyers: new Set(), bnbIn: 0, bnbOut: 0, price: 0, liq: 0, tradesStored: 0,
        snapsDone: new Set(), refPrice: null, maxX: 1, minX: 1, minLiq: Infinity, peakLiq: 0 });
    }
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
        this.writeOutcome(p, this.now(), false);
      });
    }
  }
}
