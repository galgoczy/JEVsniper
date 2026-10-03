import { createPublicClient, http, decodeEventLog, parseAbi, type PublicClient } from "viem";
import { bsc } from "viem/chains";
import type { DB } from "../db/index.js";
import { fourMemeTokenManager2Abi } from "../abis/fourmeme.js";
import { BNB, BNB_DEFAULT_RPC } from "./addresses.js";
import { log } from "../logger.js";

/**
 * BNB Chain / Four.Meme felvevő (2026-10-04, első lépés): a TokenManager2 MINDEN eseményét menti (indítás, vétel, eladás,
 * kereskedés-leállás, graduáció) – egyetlen getLogs a szerződésre, ~5 mp-enként. Nem kereskedik, árnyékpozíciót sem nyit:
 * az adatból később visszajátszhatók a belépési pillanatok (ár, görbe-haladás, vevők), és erre épülnek a szabályok.
 * Ok: a publikus RPC csak ~1,5 óra előzményt ad, ezért folyamatosan kell felvenni.
 */
export interface BnbRecorderDeps { db: DB; rpcUrl?: string; pollMs?: number; client?: PublicClient }

const CHUNK = 100n;          // a publikus végpont 100 blokkos getLogs-ot biztosan kiszolgál
const MAX_CATCHUP = 8000n;   // újraindításkor legfeljebb ennyi blokk pótlás (~1 óra; a régebbit a végpont nem adja)
const BLOCK_SEC = 0.45;      // mért átlag (verify:bnb)

export class BnbRecorder {
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  private c: PublicClient;
  stats = { tokens: 0, trades: 0, grads: 0, errors: 0, lastBlock: 0n };
  constructor(private d: BnbRecorderDeps) {
    this.c = d.client ?? (createPublicClient({ chain: bsc, transport: http((d.rpcUrl ?? BNB_DEFAULT_RPC).split(",")[0]!.trim(), { timeout: 15_000, retryCount: 1 }) }) as PublicClient);
  }

  start() { this.timer = setInterval(() => void this.tick(), this.d.pollMs ?? 5_000); void this.tick(); }
  stop() { if (this.timer) clearInterval(this.timer); }

  private getMeta(k: string) { return (this.d.db.prepare("SELECT value FROM meta WHERE key = ?").get(k) as { value: string } | undefined)?.value; }
  private setMeta(k: string, v: string) { this.d.db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)").run(k, v); }

  async tick(): Promise<void> {
    if (this.busy) return; this.busy = true;
    try {
      const head = await this.c.getBlockNumber();
      const saved = this.getMeta("bnb_last_block");
      let from = saved ? BigInt(saved) + 1n : head;
      if (head - from > MAX_CATCHUP) { log.info("BNB felvevő: túl régi kiindulópont, a pótlás a végpont korlátja miatt csak az utolsó ~1 órára", { kihagyott: Number(head - from - MAX_CATCHUP) }); from = head - MAX_CATCHUP; }
      const nowMs = Date.now();
      for (let f = from; f <= head; f += CHUNK) {
        const to = f + CHUNK - 1n > head ? head : f + CHUNK - 1n;
        const logs = await this.c.getLogs({ address: BNB.tokenManager2, fromBlock: f, toBlock: to });
        this.ingest(logs, head, nowMs);
        this.setMeta("bnb_last_block", to.toString());
        this.stats.lastBlock = to;
      }
      await this.refreshBnbUsd();
    } catch (e) {
      this.stats.errors++;
      log.debug("BNB felvevő hiba", { error: (e as Error).message.slice(0, 160) });
    } finally { this.busy = false; }
  }

  /** Események mentése. Az időbélyeg becsült: a lekérdezéskori fejblokkhoz képest blokkonként 0,45 mp (a blokkszám pontos). */
  ingest(logs: Array<{ data: `0x${string}`; topics: readonly `0x${string}`[] | `0x${string}`[]; blockNumber: bigint | null; transactionHash: `0x${string}` | null; logIndex: number | null }>, head: bigint, nowMs: number) {
    const { db } = this.d;
    const atOf = (b: bigint) => Math.round(nowMs - Number(head - b) * BLOCK_SEC * 1000);
    const insTok = db.prepare(`INSERT OR IGNORE INTO bnb_tokens(address, creator, name, symbol, total_supply, launch_time, launch_fee, request_id, created_block, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`);
    const insTrade = db.prepare(`INSERT OR IGNORE INTO bnb_trades(tx, log_index, token, block, at, side, account, price, amount, cost, fee, offers, funds)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    const insGrad = db.prepare("INSERT OR IGNORE INTO bnb_grads(token, block, at, tx, kind, quote, lp_tokens, funds) VALUES (?,?,?,?,?,?,?,?)");
    const tx = db.transaction(() => {
      for (const l of logs) {
        let d; try { d = decodeEventLog({ abi: fourMemeTokenManager2Abi, data: l.data, topics: l.topics as [`0x${string}`, ...`0x${string}`[]] }); } catch { continue; } // dokumentálatlan (díj-)esemény
        const a = d.args as Record<string, unknown>, b = l.blockNumber ?? 0n, at = atOf(b);
        const s = (x: unknown) => (typeof x === "bigint" ? x.toString() : String(x));
        if (d.eventName === "TokenCreate") {
          if (insTok.run(s(a.token).toLowerCase(), s(a.creator).toLowerCase(), s(a.name).slice(0, 80), s(a.symbol).slice(0, 40), s(a.totalSupply), Number(a.launchTime), s(a.launchFee), s(a.requestId), Number(b), at).changes) this.stats.tokens++;
        } else if (d.eventName === "TokenPurchase" || d.eventName === "TokenSale") {
          if (insTrade.run(l.transactionHash, l.logIndex ?? 0, s(a.token).toLowerCase(), Number(b), at, d.eventName === "TokenPurchase" ? "buy" : "sell", s(a.account).toLowerCase(),
            s(a.price), s(a.amount), s(a.cost), s(a.fee), s(a.offers), s(a.funds)).changes) this.stats.trades++;
        } else if (d.eventName === "TradeStop") {
          insGrad.run(s(a.token).toLowerCase(), Number(b), at, l.transactionHash, "trade_stop", null, null, null);
        } else if (d.eventName === "LiquidityAdded") {
          if (insGrad.run(s(a.base).toLowerCase(), Number(b), at, l.transactionHash, "liquidity_added", s(a.quote).toLowerCase(), s(a.offers), s(a.funds)).changes) this.stats.grads++;
        }
      }
    });
    tx();
  }

  private lastPx = 0;
  /** BNB/USD a Chainlink feedből percenként (meta: bnb_usd) – a későbbi USD-átszámításhoz. */
  private async refreshBnbUsd() {
    if (Date.now() - this.lastPx < 60_000) return; this.lastPx = Date.now();
    const abi = parseAbi(["function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)", "function decimals() view returns (uint8)"]);
    const [rd, dec] = await Promise.all([this.c.readContract({ address: BNB.chainlinkBnbUsd, abi, functionName: "latestRoundData" }), this.c.readContract({ address: BNB.chainlinkBnbUsd, abi, functionName: "decimals" })]);
    this.setMeta("bnb_usd", String(Number(rd[1]) / 10 ** dec)); this.setMeta("bnb_usd_at", String(Date.now()));
  }
}
