import { type Address, type PublicClient, keccak256, isAddressEqual, formatUnits, getAddress } from "viem";
import type { DB } from "../db/index.js";
import { nowMs } from "../db/index.js";
import type { ChainKey } from "../chains/index.js";
import { ADDRESSES, ZERO } from "../chains/addresses.js";
import { erc20Abi } from "../abis/uniswap.js";
import { ponsCurveAbi } from "../abis/pons.js";
import { uniswapV2PairAbi, uniswapV3PoolAbi, uniswapV4SwapAbi, transferEventAbi, ownableAbi, chainlinkAggregatorAbi } from "../abis/pools.js";
import { holderStats, swapStats, priceFromSqrtX96, findDangerousSelectors, type SwapRec, type TransferRec } from "./stats.js";
import { UniswapV4Route, type PoolKey } from "../exec/routes.js";
import type { ParamSnapshot, U } from "./types.js";
import { log } from "../logger.js";

export interface TokenRow {
  id: number; chain: ChainKey; address: Address; creator: Address | null; launchpad: string; mechanics: string;
  pool_address: string | null; pair_token: string | null; name: string | null; symbol: string | null;
  discovered_at: number; discovered_block: number | null; graduated_at: number | null;
  graduation_threshold?: string | null;
  pool_key_json?: string | null;
}

const num = (v: bigint, dec = 18) => Number(formatUnits(v, dec));

/** getLogs darabolva (a publikus RPC-k nagy blokktartományt elutasítanak); max. `maxSpan` blokkot néz vissza. */
// Robinhood Chain ~0,26 mp blokkidő → kisebb darab; a verify:step2 800 blokkal biztosan működött
const CHUNK: Record<ChainKey, bigint> = { base: 2000n, robinhood: 500n };
const MAX_SPAN: Record<ChainKey, bigint> = { base: 20_000n, robinhood: 20_000n };
let currentChain: ChainKey = "base";
async function getLogsChunked<T>(from: bigint, to: bigint, fetch: (f: bigint, t: bigint) => Promise<T[]>): Promise<T[]> {
  const chunk = CHUNK[currentChain], span = MAX_SPAN[currentChain];
  const start = to - from > span ? to - span : from;
  const out: T[] = [];
  for (let f = start; f <= to; f += chunk + 1n) {
    const t = f + chunk > to ? to : f + chunk;
    out.push(...await fetch(f, t));
  }
  return out;
}
const unk = "unknown" as const;

/** ETH/USD Chainlinkről (Base), 60 mp cache. Robinhood Chainen is ezt használjuk (ETH = ETH). */
export class EthPrice {
  private cache: { at: number; usd: number } | null = null;
  constructor(private baseClient: PublicClient | null) {}
  async get(): Promise<U<number>> {
    if (this.cache && Date.now() - this.cache.at < 60_000) return this.cache.usd;
    const feed = ADDRESSES.base.chainlinkEthUsd;
    if (!this.baseClient || !feed) return unk;
    try {
      const [round, dec] = await Promise.all([
        this.baseClient.readContract({ address: feed, abi: chainlinkAggregatorAbi, functionName: "latestRoundData" }),
        this.baseClient.readContract({ address: feed, abi: chainlinkAggregatorAbi, functionName: "decimals" }),
      ]);
      const usd = Number(round[1]) / 10 ** dec;
      this.cache = { at: Date.now(), usd };
      return usd;
    } catch (e) { log.debug("ETH/USD hiba", { error: (e as Error).message }); return this.cache?.usd ?? unk; }
  }
}

interface LogCache { lastBlock: bigint; transfers: TransferRec[]; swaps: SwapRec[]; launchPrice: number | null; at: number }

export class Collector {
  /** Tokenenként az eddig lekért transzferek/swapok – a következő ablakban csak az új blokkokat kérjük. */
  private logCache = new Map<number, LogCache>();
  private blockTsCache = new Map<string, number>();
  private txCountCache = new Map<string, { n: number; at: number }>();
  private running: Record<ChainKey, number> = { base: 0, robinhood: 0 };
  private waiters: Record<ChainKey, Array<() => void>> = { base: [], robinhood: [] };
  /** Láncenként max. ennyi gyűjtés fut egyszerre (RPC-kímélés). */
  static MAX_CONCURRENT = 2;

  private async acquire(chain: ChainKey) {
    if (this.running[chain] < Collector.MAX_CONCURRENT) { this.running[chain]++; return; }
    await new Promise<void>((r) => this.waiters[chain].push(r));
    this.running[chain]++;
  }
  private release(chain: ChainKey) { this.running[chain]--; this.waiters[chain].shift()?.(); }

  /** Utolsó tx-szám lekérési hiba (diagnosztika a verify-hez). */
  public lastTxCountError: string | null = null;
  public lastPoolError: string | null = null;
  /** Az utolsó collect() során elnyelt RPC-hibák (diagnosztika). */
  public errors: string[] = [];
  private err(where: string) { return (e: unknown) => { this.errors.push(`${where}: ${(e as Error).message.split("\n")[0]!.slice(0, 160)}`); return null; }; }
  private codeCache = new Map<string, boolean>();
  constructor(private db: DB, private clients: Record<ChainKey, PublicClient>, private ethPrice: EthPrice) {}

  async collect(t: TokenRow, windowSec: number): Promise<ParamSnapshot> {
    await this.acquire(t.chain);
    try { return await this.collectInner(t, windowSec); } finally { this.release(t.chain); }
  }

  private async collectInner(t: TokenRow, windowSec: number): Promise<ParamSnapshot> {
    const c = this.clients[t.chain];
    currentChain = t.chain;
    this.errors = [];
    const takenAt = nowMs();
    // régi cache-bejegyzések kidobása (memória)
    for (const [id, v] of this.logCache) if (takenAt - v.at > 15 * 60_000) this.logCache.delete(id);
    const [head, ethUsd, gasPrice] = await Promise.all([c.getBlockNumber(), this.ethPrice.get(), c.getGasPrice().catch(() => null)]);
    const headBlock = await c.getBlock({ blockNumber: head }).catch(() => null);
    const fromBlock = BigInt(t.discovered_block ?? Number(head));
    const pool = t.pool_address && /^0x[0-9a-fA-F]{40}$/.test(t.pool_address) ? getAddress(t.pool_address) : null; // v4-nél poolId, nem cím
    const poolId = t.pool_address && t.pool_address.length === 66 ? (t.pool_address as `0x${string}`) : null;
    const pair = (t.pair_token ?? ZERO) as Address;

    // --- szerződés
    const [code, mc] = await Promise.all([
      c.getCode({ address: t.address }).catch(() => undefined),
      c.multicall({ allowFailure: true, contracts: [
        { address: t.address, abi: erc20Abi, functionName: "decimals" },
        { address: t.address, abi: erc20Abi, functionName: "totalSupply" },
        { address: t.address, abi: ownableAbi, functionName: "owner" },
        { address: t.address, abi: erc20Abi, functionName: "name" },
        { address: t.address, abi: erc20Abi, functionName: "symbol" },
      ] }).catch((e) => { this.err("multicall(token)")(e); return null; }),
    ]);
    const mcv = (i: number) => (mc && mc[i]?.status === "success" ? mc[i]!.result : null);
    const decimalsR = mcv(0) as number | null, supplyR = mcv(1) as bigint | null, ownerR = mcv(2) as Address | null;
    if ((!t.name || !t.symbol) && (mcv(3) || mcv(4))) {
      t.name = t.name ?? (mcv(3) as string | null); t.symbol = t.symbol ?? (mcv(4) as string | null);
      this.db.prepare("UPDATE tokens SET name = COALESCE(name, ?), symbol = COALESCE(symbol, ?) WHERE id = ?").run(mcv(3), mcv(4), t.id);
    }
    const decimals = decimalsR ?? 18;
    const totalSupply = supplyR ?? 0n;
    const bytecodeHash = code ? keccak256(code) : "0x";
    const dangerous = code ? findDangerousSelectors(code) : unk;
    const renounced: U<boolean> = ownerR === null ? (t.launchpad === "pons" || t.launchpad === "clanker" ? true : unk) : isAddressEqual(ownerR, ZERO);
    const knownTemplate = this.isKnownTemplate(t, bytecodeHash);
    if (bytecodeHash !== "0x") this.db.prepare("UPDATE tokens SET bytecode_hash = ? WHERE id = ?").run(bytecodeHash, t.id);


    // --- transzferek → holderek
    const cache = this.logCache.get(t.id) ?? { lastBlock: fromBlock - 1n, transfers: [], swaps: [], launchPrice: null, at: takenAt };
    const logFrom = cache.lastBlock + 1n;
    if (head >= logFrom) {
      const fresh = await this.transfers(c, t.address, logFrom, head, decimals).catch((e) => { this.err("Transfer-logok")(e); return null; });
      if (fresh) cache.transfers.push(...fresh);
    }
    const transfers = cache.transfers;

    // --- pool / curve állapot + swapok (a swapok is inkrementálisan a cache-be)
    // --- pool / curve állapot + swapok
    const ps = await this.poolState(t, c, pool, poolId, pair, decimals, logFrom, head, cache).catch((e) => {
      this.lastPoolError = (e as Error).message.slice(0, 300); this.err("pool/curve")(e);
      log.debug("poolState hiba", { token: t.address, error: (e as Error).message }); return null;
    });
    cache.lastBlock = head; cache.at = takenAt; this.logCache.set(t.id, cache);
    const contractSenders = await this.contractSet(c, transfers.map((x) => x.from));
    const hs = holderStats(transfers, { pool: pool ?? (ps?.poolAddressForTransfers ?? null), creator: t.creator, totalSupply, contractSenders });

    // --- top20 wallet: friss-e (tx-szám), listák
    const top20 = hs.top20.slice(0, 10); // top10 elég a friss-arányhoz, fele annyi hívás
    const txCounts: Array<number | null> = [];
    for (const a of top20) {
      const cached = this.txCountCache.get(a);
      if (cached && takenAt - cached.at < 10 * 60_000) { txCounts.push(cached.n); continue; }
      const n = await c.getTransactionCount({ address: a as Address })
        .catch((e) => { this.lastTxCountError = (e as Error).message.slice(0, 300); this.err("tx-szám")(e); return null; });
      if (n !== null) this.txCountCache.set(a, { n, at: takenAt });
      txCounts.push(n);
    }
    const known = txCounts.filter((n): n is number => n !== null);
    const freshRatio: U<number> = known.length ? known.filter((n) => n <= 3).length / known.length : unk;
    const lists = this.walletLists(t.chain, [...top20, ...(ps?.swaps.map((s) => s.buyer) ?? [])]);

    // --- creator
    const [creatorTx, creatorBal] = t.creator
      ? await Promise.all([c.getTransactionCount({ address: t.creator }).catch(this.err("creator tx-szám")), c.getBalance({ address: t.creator }).catch(this.err("creator egyenleg"))])
      : [null, null];
    const creatorRows = t.creator ? this.db.prepare("SELECT COUNT(*) n, SUM(discovered_at > ?) n24, SUM(graduated_at IS NOT NULL) g FROM tokens WHERE chain = ? AND lower(creator) = lower(?) AND id != ?")
      .get(takenAt - 86_400_000, t.chain, t.creator, t.id) as { n: number; n24: number | null; g: number | null } : { n: 0, n24: 0, g: 0 };
    const creatorStatus = t.creator ? this.creatorStatus(t.chain, t.creator) : "unknown";

    // --- dinamika
    const launchTs = t.discovered_at;
    const liqNative = ps?.liquidityNative ?? null;
    const dyn = swapStats(ps?.swaps ?? [], { launchTs, nowTs: takenAt, liquidityNative: liqNative, launchPriceNative: ps?.launchPriceNative ?? null });
    const priceNative: U<number> = ps?.priceNative ?? dyn.price_native;
    const buyers = new Set((ps?.swaps ?? []).filter((s) => s.isBuy).map((s) => s.buyer.toLowerCase()));
    const stillHolding = [...buyers].filter((b) => (hs.balances.get(b) ?? 0n) > 0n).length;
    const launchBlock = fromBlock;
    const botBuys = (ps?.swaps ?? []).filter((s) => s.isBuy && s.block <= launchBlock + 2n).length;

    // --- meta, launchpad-kontextus
    const copycats = (this.db.prepare("SELECT COUNT(*) n FROM tokens WHERE discovered_at > ? AND id != ? AND (lower(symbol) = lower(?) OR lower(name) = lower(?))")
      .get(takenAt - 86_400_000, t.id, t.symbol ?? "", t.name ?? "") as { n: number }).n;
    const trending = (this.db.prepare("SELECT symbol, COUNT(*) n FROM tokens WHERE discovered_at > ? AND symbol IS NOT NULL GROUP BY lower(symbol) HAVING n > 1 ORDER BY n DESC LIMIT 5")
      .all(takenAt - 3_600_000) as { symbol: string }[]).map((r) => r.symbol);
    const lp24 = this.db.prepare("SELECT COUNT(*) n, SUM(graduated_at IS NOT NULL) g FROM tokens WHERE chain = ? AND launchpad = ? AND discovered_at > ?")
      .get(t.chain, t.launchpad, takenAt - 86_400_000) as { n: number; g: number | null };
    const lp1h = (this.db.prepare("SELECT COUNT(*) n FROM tokens WHERE chain = ? AND launchpad = ? AND discovered_at > ?").get(t.chain, t.launchpad, takenAt - 3_600_000) as { n: number }).n;

    const usd = (eth: U<number>): U<number> => (typeof eth === "number" && typeof ethUsd === "number" ? eth * ethUsd : unk);
    const mcapUsd: U<number> = typeof priceNative === "number" && typeof ethUsd === "number" && totalSupply > 0n ? priceNative * num(totalSupply, decimals) * ethUsd : unk;

    const snap: ParamSnapshot = {
      meta_snapshot: { chain: t.chain, token: t.address, window_sec: windowSec, taken_at: takenAt, block: Number(head), elapsed_sec: Math.round((takenAt - launchTs) / 1000), eth_usd: ethUsd },
      contract: {
        launchpad: t.launchpad, mechanics: t.mechanics, known_template: knownTemplate, bytecode_hash: bytecodeHash,
        dangerous_rights: dangerous, renounced,
        sell_simulation: ps?.sellSimulation ?? unk, buy_tax_pct: ps?.buyTaxPct ?? unk, sell_tax_pct: ps?.sellTaxPct ?? unk,
        liquidity_locked: t.launchpad === "pons" || t.launchpad === "clanker" ? true : unk,
        liquidity_native: liqNative ?? unk, liquidity_usd: usd(liqNative ?? unk),
        market_cap_usd: mcapUsd, total_supply: totalSupply > 0n ? num(totalSupply, decimals) : unk, decimals,
        bonding_curve_progress_pct: ps?.curveProgressPct ?? (t.mechanics === "bonding_curve" ? unk : 100), graduated: ps?.graduated ?? (t.graduated_at ? true : t.mechanics !== "bonding_curve"),
      },
      creator: {
        address: t.creator ?? unk, prior_tokens: creatorRows.n, prior_tokens_24h: creatorRows.n24 ?? 0, prior_graduated: creatorRows.g ?? 0,
        wallet_tx_count: creatorTx ?? unk, wallet_balance_eth: creatorBal !== null ? num(creatorBal) : unk,
        token_share_pct: hs.creator_share_pct, sold_any: hs.creator_sold_any, sold_pct_of_initial: hs.creator_sold_pct, status: creatorStatus,
      },
      holders: {
        count: hs.count, growth_per_min: hs.count / Math.max((takenAt - launchTs) / 60_000, 1 / 60),
        top1_pct_ex_creator: hs.top1_pct_ex_creator, top10_pct_ex_creator: hs.top10_pct_ex_creator,
        fresh_wallet_ratio_top20: freshRatio, funding_clusters_top20: unk,
        airdrop_received_ratio: hs.airdrop_received_ratio, transfers_from_creator: hs.transfers_from_creator,
      },
      buyers: {
        smart_money_count: lists.smart, known_scammer_count: lists.scammer,
        bot_ratio: dyn.buys ? botBuys / dyn.buys : unk,
        avg_buy_native: dyn.avg_buy_native, median_buy_native: dyn.median_buy_native, largest_buy_pct_of_liquidity: dyn.largest_buy_pct_of_liquidity,
        holders_ratio: buyers.size ? stillHolding / buyers.size : unk, unique_buyers: dyn.unique_buyers, returning_buyers: dyn.returning_buyers,
      },
      dynamics: {
        buys: dyn.buys, sells: dyn.sells, buy_volume_native: dyn.buy_volume_native, sell_volume_native: dyn.sell_volume_native,
        buys_per_min: dyn.buys_per_min, sells_per_min: dyn.sells_per_min, buy_sell_ratio: dyn.buy_sell_ratio, net_inflow_native: dyn.net_inflow_native,
        unique_buyers_per_min: dyn.unique_buyers_per_min, buyer_acceleration: dyn.buyer_acceleration,
        price_native: priceNative, price_change_pct_since_launch: dyn.price_change_pct_since_launch, peak_drawdown_pct: dyn.peak_drawdown_pct, volatility_pct: dyn.volatility_pct,
        large_sells: dyn.large_sells, est_graduation_min: ps?.estGraduationMin ?? unk,
      },
      meta: {
        name: t.name ?? unk, symbol: t.symbol ?? unk, copycats_24h: copycats, trending_tickers_1h: trending,
        has_logo: unk, stock_themed: t.chain === "robinhood" ? /\b(stock|equity|share|nasdaq|nyse|etf|ipo)\b/i.test(`${t.name} ${t.symbol}`) : false,
      },
      social: { telegram: unk, x: unk, website: unk, members: unk, paid_boost: unk },
      launchpad_ctx: {
        launches_24h: lp24.n, graduated_24h: lp24.g ?? 0, graduation_rate_24h: lp24.n ? (lp24.g ?? 0) / lp24.n : unk,
        launches_1h: lp1h, alive_1h: unk, token_rank_1h: unk,
      },
      timing: {
        hour_utc: new Date(takenAt).getUTCHours(), weekend: [0, 6].includes(new Date(takenAt).getUTCDay()),
        gas_price_gwei: gasPrice !== null ? Number(gasPrice) / 1e9 : unk,
        block_lag_sec: headBlock ? Math.max(0, Math.round(takenAt / 1000 - Number(headBlock.timestamp))) : unk,
      },
    };
    return snap;
  }

  /** Pillanatkép mentése (méretkorlát a configból). */
  saveSnapshot(t: TokenRow, snap: ParamSnapshot, maxBytes: number) {
    let json = JSON.stringify(snap);
    if (json.length > maxBytes) { snap.meta.trending_tickers_1h = []; json = JSON.stringify(snap).slice(0, maxBytes); }
    const price = typeof snap.dynamics.price_native === "number" ? snap.dynamics.price_native : null;
    this.db.prepare(`INSERT OR REPLACE INTO snapshots(token_id, window_sec, taken_at, block_number, price_native, reserve_native, reserve_token, params_json)
      VALUES (?,?,?,?,?,?,?,?)`).run(t.id, snap.meta_snapshot.window_sec, snap.meta_snapshot.taken_at, snap.meta_snapshot.block, price,
      typeof snap.contract.liquidity_native === "number" ? snap.contract.liquidity_native : null, null, json);
  }

  /** Mely küldők szerződések (pool, router, PoolManager) – ezek vételt jelentenek, nem airdropot. */
  private async contractSet(c: PublicClient, addrs: string[]): Promise<Set<string>> {
    const ZERO_L = ZERO.toLowerCase();
    const uniq = [...new Set(addrs.map((a) => a.toLowerCase()))].filter((a) => a !== ZERO_L);
    const todo = uniq.filter((a) => !this.codeCache.has(a)).slice(0, 60);
    for (let i = 0; i < todo.length; i += 5) {
      await Promise.all(todo.slice(i, i + 5).map(async (a) => {
        const code = await c.getCode({ address: a as Address }).catch(() => undefined);
        if (code !== undefined) this.codeCache.set(a, code !== "0x" && code.length > 2);
      }));
    }
    return new Set(uniq.filter((a) => this.codeCache.get(a) === true));
  }

  private isKnownTemplate(t: TokenRow, hash: string): U<boolean> {
    if (hash === "0x") return unk;
    const n = (this.db.prepare("SELECT COUNT(*) n FROM tokens WHERE chain = ? AND bytecode_hash = ? AND id != ?").get(t.chain, hash, t.id) as { n: number }).n;
    if (t.launchpad === "pons" || t.launchpad === "clanker") return true; // gyári sablon
    return n >= 3; // ≥3 másik token ugyanazzal a bytecode-dal → ismert sablon
  }

  private walletLists(chain: ChainKey, addrs: string[]) {
    const uniq = [...new Set(addrs.map((a) => a.toLowerCase()))];
    let smart = 0, scammer = 0;
    const q = this.db.prepare("SELECT list FROM wallet_lists WHERE chain = ? AND lower(address) = ? AND occurrences >= 5");
    for (const a of uniq) for (const r of q.all(chain, a) as { list: string }[]) { if (r.list === "smart_money") smart++; if (r.list === "scammer" || r.list === "insider") scammer++; }
    return { smart, scammer };
  }

  private creatorStatus(chain: ChainKey, creator: string): "known_good" | "known_scammer" | "unknown" {
    const rows = this.db.prepare("SELECT list FROM wallet_lists WHERE chain = ? AND lower(address) = lower(?) AND occurrences >= 5").all(chain, creator) as { list: string }[];
    if (rows.some((r) => r.list === "creator_bad")) return "known_scammer";
    if (rows.some((r) => r.list === "creator_good")) return "known_good";
    return "unknown";
  }

  private async transfers(c: PublicClient, token: Address, from: bigint, to: bigint, _dec: number): Promise<TransferRec[]> {
    const logs = await getLogsChunked(from, to, (f, t) => c.getLogs({ address: token, event: transferEventAbi[0], fromBlock: f, toBlock: t }));
    return logs.map((l) => ({ from: l.args.from!, to: l.args.to!, value: l.args.value!, block: l.blockNumber! }));
  }

  private async blockTs(c: PublicClient, blocks: Set<bigint>): Promise<Map<bigint, number>> {
    const m = new Map<bigint, number>();
    const arr = [...blocks].sort((a, b) => (a < b ? -1 : 1));
    // csak első/utolsó blokk időbélyege (cache-elve), a többi lineárisan interpolálva
    if (!arr.length) return m;
    const ts = async (b: bigint) => {
      const k = `${currentChain}:${b}`;
      const hit = this.blockTsCache.get(k); if (hit) return hit;
      const v = Number((await c.getBlock({ blockNumber: b })).timestamp) * 1000;
      this.blockTsCache.set(k, v); if (this.blockTsCache.size > 5000) this.blockTsCache.clear();
      return v;
    };
    const [t0, t1] = await Promise.all([ts(arr[0]!), ts(arr.at(-1)!)]);
    const span = Number(arr.at(-1)! - arr[0]!) || 1;
    for (const b of arr) m.set(b, t0 + ((t1 - t0) * Number(b - arr[0]!)) / span);
    return m;
  }

  private async poolState(t: TokenRow, c: PublicClient, pool: Address | null, poolId: `0x${string}` | null, pair: Address, dec: number, from: bigint, to: bigint, cache: LogCache) {
    const A = ADDRESSES[t.chain];
    const out = {
      swaps: cache.swaps, priceNative: unk as U<number>, liquidityNative: null as number | null, launchPriceNative: cache.launchPrice,
      sellSimulation: unk as U<"ok" | "failed" | "not_supported">, buyTaxPct: unk as U<number>, sellTaxPct: unk as U<number>,
      curveProgressPct: unk as U<number>, graduated: undefined as boolean | undefined, estGraduationMin: unk as U<number>,
      poolAddressForTransfers: null as string | null,
    };
    const tokenIsC0 = BigInt(t.address) < BigInt(pair === ZERO ? ZERO : pair);

    if (t.mechanics === "bonding_curve" && pool) {
      out.poolAddressForTransfers = pool;
      const fns = ["quoteReserve", "tokenReserve", "reservedTokens", "feeBps", "creatorTaxBps", "graduated"] as const;
      const mc = await c.multicall({ allowFailure: true, contracts: fns.map((fn) => ({ address: pool, abi: ponsCurveAbi, functionName: fn })) })
        .catch((e) => { this.err("multicall(curve)")(e); return null; });
      const v = (i: number) => (mc && mc[i]?.status === "success" ? mc[i]!.result : null);
      const [q, tk, rs, fee, tax, grad] = [v(0) as bigint | null, v(1) as bigint | null, v(2) as bigint | null, v(3) as bigint | null, v(4) as bigint | null, v(5) as boolean | null];
      if (typeof q === "bigint" && typeof tk === "bigint" && tk > 0n) {
        out.priceNative = Number(q) / Number(tk) * 10 ** (dec - 18);
        out.liquidityNative = num(q);
        const threshold = t.graduation_threshold ? BigInt(t.graduation_threshold) : null;
        if (threshold && threshold > 0n) {
          out.curveProgressPct = Math.min(100, Number((q * 10000n) / threshold) / 100);
          const elapsedMin = Math.max((nowMs() - t.discovered_at) / 60_000, 0.1);
          const rate = num(q) / elapsedMin; // ETH/perc eddigi átlag
          out.estGraduationMin = rate > 0 ? Math.round((num(threshold - q) / rate) * 10) / 10 : unk;
        }
      }
      if (typeof fee === "bigint" && typeof tax === "bigint") { out.buyTaxPct = Number(fee + tax) / 100; out.sellTaxPct = Number(fee + tax) / 100; }
      out.graduated = grad === true;
      // Csak előzetes jelzés: a valódi eladás-szimuláció (eth_call) az 5. lépésben. RPC-hiba → unknown, nem "failed".
      out.sellSimulation = grad === true ? "not_supported" : typeof q === "bigint" && typeof tk === "bigint" && tk > 0n ? "ok" : unk;
      const curveEvents = ponsCurveAbi.filter((x) => x.type === "event");
      const rawLogs = to < from ? [] : await getLogsChunked(from, to, (f, t) => c.getLogs({ address: pool, events: curveEvents, fromBlock: f, toBlock: t }) as Promise<unknown[]>);
      const logs = rawLogs as unknown as Array<{ eventName: string; args: Record<string, bigint | string>; blockNumber: bigint }>;
      const ts = await this.blockTs(c, new Set(logs.map((l) => l.blockNumber)));
      for (const l of logs) {
        const isBuy = l.eventName === "CurveBuy";
        const native = num((isBuy ? l.args.quoteIn : l.args.quoteOut) as bigint);
        const tokens = num((isBuy ? l.args.tokensOut : l.args.tokensIn) as bigint, dec);
        out.swaps.push({ buyer: String(isBuy ? l.args.buyer : l.args.seller), isBuy, native, tokens, block: l.blockNumber, ts: ts.get(l.blockNumber) ?? 0, priceNative: tokens > 0 ? native / tokens : null });
      }
      if (out.launchPriceNative === null && out.swaps[0]?.priceNative) out.launchPriceNative = out.swaps[0].priceNative;
      cache.launchPrice = out.launchPriceNative;
      return out;
    }

    if ((t.mechanics === "v4" || t.mechanics === "v4_hook") && poolId && A.uniswapV4PoolManager) {
      const pm = A.uniswapV4PoolManager;
      const logs = to < from ? [] : await getLogsChunked(from, to, (f, t) => c.getLogs({ address: pm, event: uniswapV4SwapAbi[0], args: { id: poolId }, fromBlock: f, toBlock: t }));
      const ts = await this.blockTs(c, new Set(logs.map((l) => l.blockNumber!)));
      for (const l of logs) {
        const a0 = l.args.amount0!, a1 = l.args.amount1!;
        const tokenAmt = tokenIsC0 ? a0 : a1, quoteAmt = tokenIsC0 ? a1 : a0;
        const isBuy = tokenAmt < 0n; // a pool tokent ad ki (negatív a pool szemszögéből = kifelé)
        const price = priceFromSqrtX96(l.args.sqrtPriceX96!, tokenIsC0, dec);
        out.swaps.push({ buyer: l.args.sender!, isBuy, native: Math.abs(num(quoteAmt)), tokens: Math.abs(num(tokenAmt, dec)), block: l.blockNumber!, ts: ts.get(l.blockNumber!) ?? 0, priceNative: price });
      }
      if (out.swaps.length) { out.priceNative = out.swaps.at(-1)!.priceNative!; if (out.launchPriceNative === null) out.launchPriceNative = out.swaps[0]!.priceNative; cache.launchPrice = out.launchPriceNative; }
      out.buyTaxPct = 0; out.sellTaxPct = 0; // v4 poolnál a hook-díj a Swap eventben (fee), adó nincs
      // Eladás-szimuláció a hivatalos v4 Quoterrel: kis próbavétel, majd a kapott mennyiség eladása (2 eth_call).
      if (t.pool_key_json) {
        try {
          const route = new UniswapV4Route(c, t.chain, t.address, JSON.parse(t.pool_key_json) as PoolKey);
          const probe = 10n ** 15n; // 0,001 ETH
          const b = await route.quoteBuy(probe);
          const sOut = (await route.quoteSell(b.amountOut)).amountOut;
          out.sellSimulation = sOut > 0n ? "ok" : "failed";
          if (b.estLiquidityNative !== undefined) out.liquidityNative = b.estLiquidityNative;
          const roundTrip = Number(sOut) / Number(probe); // 1 = veszteségmentes; a díjak + csúszás miatt < 1
          out.sellTaxPct = Math.max(0, Math.round((1 - roundTrip) * 10000) / 100 / 2); // oda-vissza veszteség fele ≈ effektív egyirányú költség
          if (out.priceNative === unk && b.amountOut > 0n) out.priceNative = Number(probe) / Number(b.amountOut) * 10 ** (dec - 18);
        } catch (e) {
          const m = (e as Error).message;
          out.sellSimulation = m.includes("NotEnoughLiquidity") || m.includes("6190b2b0") || m.includes("reverted") ? "failed" : unk;
          if (out.sellSimulation === unk) this.err("v4 quoter")(e);
        }
      } else out.sellSimulation = unk;
      return out;
    }

    if (t.mechanics === "v2" && pool) {
      out.poolAddressForTransfers = pool;
      const mc2 = await c.multicall({ allowFailure: true, contracts: [
        { address: pool, abi: uniswapV2PairAbi, functionName: "getReserves" },
        { address: pool, abi: uniswapV2PairAbi, functionName: "token0" },
      ] }).catch((e) => { this.err("multicall(v2)")(e); return null; });
      const res = mc2?.[0]?.status === "success" ? mc2[0].result : null;
      const t0 = mc2?.[1]?.status === "success" ? mc2[1].result : null;
      const isT0 = t0 ? isAddressEqual(t0, t.address) : tokenIsC0;
      if (res) {
        const rt = isT0 ? res[0] : res[1], rq = isT0 ? res[1] : res[0];
        out.liquidityNative = num(rq);
        if (rt > 0n) out.priceNative = Number(rq) / Number(rt) * 10 ** (dec - 18);
      }
      const logs = to < from ? [] : await getLogsChunked(from, to, (f, t) => c.getLogs({ address: pool, event: uniswapV2PairAbi[0], fromBlock: f, toBlock: t }));
      const ts = await this.blockTs(c, new Set(logs.map((l) => l.blockNumber!)));
      for (const l of logs) {
        const tokOut = isT0 ? l.args.amount0Out! : l.args.amount1Out!, tokIn = isT0 ? l.args.amount0In! : l.args.amount1In!;
        const qIn = isT0 ? l.args.amount1In! : l.args.amount0In!, qOut = isT0 ? l.args.amount1Out! : l.args.amount0Out!;
        const isBuy = tokOut > 0n;
        const native = num(isBuy ? qIn : qOut), tokens = num(isBuy ? tokOut : tokIn, dec);
        out.swaps.push({ buyer: l.args.to!, isBuy, native, tokens, block: l.blockNumber!, ts: ts.get(l.blockNumber!) ?? 0, priceNative: tokens > 0 ? native / tokens : null });
      }
      if (out.launchPriceNative === null && out.swaps[0]?.priceNative) out.launchPriceNative = out.swaps[0].priceNative;
      cache.launchPrice = out.launchPriceNative;
      out.sellSimulation = unk; // v2 eladás-szimuláció az 5. lépésben (router getAmountsOut + eth_call)
      return out;
    }

    if (t.mechanics === "v3" && pool) {
      out.poolAddressForTransfers = pool;
      const mc3 = await c.multicall({ allowFailure: true, contracts: [
        { address: pool, abi: uniswapV3PoolAbi, functionName: "slot0" },
        { address: pool, abi: uniswapV3PoolAbi, functionName: "token0" },
      ] }).catch((e) => { this.err("multicall(v3)")(e); return null; });
      const slot = mc3?.[0]?.status === "success" ? mc3[0].result : null;
      const t0 = mc3?.[1]?.status === "success" ? mc3[1].result : null;
      const isT0 = t0 ? isAddressEqual(t0, t.address) : tokenIsC0;
      if (slot) out.priceNative = priceFromSqrtX96(slot[0], isT0, dec);
      const logs = to < from ? [] : await getLogsChunked(from, to, (f, t) => c.getLogs({ address: pool, event: uniswapV3PoolAbi[0], fromBlock: f, toBlock: t }));
      const ts = await this.blockTs(c, new Set(logs.map((l) => l.blockNumber!)));
      for (const l of logs) {
        const tokenAmt = isT0 ? l.args.amount0! : l.args.amount1!, quoteAmt = isT0 ? l.args.amount1! : l.args.amount0!;
        const isBuy = tokenAmt < 0n;
        out.swaps.push({ buyer: l.args.recipient!, isBuy, native: Math.abs(num(quoteAmt)), tokens: Math.abs(num(tokenAmt, dec)), block: l.blockNumber!, ts: ts.get(l.blockNumber!) ?? 0, priceNative: priceFromSqrtX96(l.args.sqrtPriceX96!, isT0, dec) });
      }
      if (out.launchPriceNative === null && out.swaps[0]?.priceNative) out.launchPriceNative = out.swaps[0].priceNative;
      cache.launchPrice = out.launchPriceNative;
      out.sellSimulation = "not_supported";
      return out;
    }
    return out;
  }
}

/** Ütemező: új tokenre a config ablakaiban (30/60/180 mp) lefuttatja a gyűjtést és menti. */
export class CollectorScheduler {
  private timers = new Set<NodeJS.Timeout>();
  constructor(private db: DB, private collector: Collector, private windows: number[], private maxBytes: number,
    private onSnapshot?: (t: TokenRow, snap: ParamSnapshot) => void | Promise<void>) {}

  schedule(t: TokenRow) {
    for (const w of this.windows) {
      const delay = Math.max(0, t.discovered_at + w * 1000 - Date.now());
      const h = setTimeout(async () => {
        this.timers.delete(h);
        try {
          const snap = await this.collector.collect(t, w);
          this.collector.saveSnapshot(t, snap, this.maxBytes);
          await this.onSnapshot?.(t, snap);
        } catch (e) { log.warn("Paramétergyűjtés hiba", { token: t.address, window: w, error: (e as Error).message.slice(0, 200) }); }
      }, delay);
      this.timers.add(h);
    }
  }
  stop() { for (const h of this.timers) clearTimeout(h); this.timers.clear(); }
}

export function tokenRow(db: DB, id: number): TokenRow | undefined {
  return db.prepare("SELECT * FROM tokens WHERE id = ?").get(id) as TokenRow | undefined;
}

/** Hány mező "unknown" a pillanatképben (verify-hez). */
export function countUnknown(snap: ParamSnapshot): { total: number; unknown: number; unknownKeys: string[] } {
  let total = 0; const unknownKeys: string[] = [];
  for (const [g, obj] of Object.entries(snap)) for (const [k, v] of Object.entries(obj as Record<string, unknown>)) { total++; if (v === "unknown") unknownKeys.push(`${g}.${k}`); }
  return { total, unknown: unknownKeys.length, unknownKeys };
}
