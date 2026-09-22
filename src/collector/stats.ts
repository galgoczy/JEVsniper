/**
 * Tiszta (RPC nélküli) aggregációk: transzferekből holder-statisztika, swapokból dinamika.
 * Ezeket teszteljük szintetikus adattal.
 */
import type { U } from "./types.js";

export interface TransferRec { from: string; to: string; value: bigint; block: bigint }
export interface SwapRec { buyer: string; isBuy: boolean; native: number; tokens: number; block: bigint; ts: number; priceNative: number | null }

const lc = (a: string) => a.toLowerCase();
const ZERO = "0x0000000000000000000000000000000000000000";

export function holderStats(transfers: TransferRec[], opts: { pool: string | null; creator: string | null; totalSupply: bigint; contractSenders?: Set<string> }) {
  const contracts = new Set([...(opts.contractSenders ?? [])].map(lc));
  const bal = new Map<string, bigint>();
  const receivedNotFromPool = new Set<string>();
  const pool = opts.pool ? lc(opts.pool) : null;
  const creator = opts.creator ? lc(opts.creator) : null;
  let transfersFromCreator = 0;
  let creatorReceived = 0n, creatorSentToPool = 0n;
  for (const t of transfers) {
    const f = lc(t.from), to = lc(t.to);
    if (f !== ZERO) bal.set(f, (bal.get(f) ?? 0n) - t.value);
    bal.set(to, (bal.get(to) ?? 0n) + t.value);
    if (creator && f === creator && to !== pool) transfersFromCreator++;
    if (creator && to === creator) creatorReceived += t.value;
    if (creator && f === creator && to === pool) creatorSentToPool += t.value;
    // airdrop = sima walletből (nem pool/router/PoolManager szerződésből) kapott token
    if (f !== pool && f !== ZERO && !contracts.has(f) && to !== pool && to !== creator) receivedNotFromPool.add(to);
  }
  const excluded = new Set([ZERO, pool, creator].filter(Boolean) as string[]);
  const holders = [...bal.entries()].filter(([a, v]) => v > 0n && !excluded.has(a)).sort((x, y) => (y[1] > x[1] ? 1 : y[1] < x[1] ? -1 : 0));
  const circulating = holders.reduce((s, [, v]) => s + v, 0n);
  const pct = (v: bigint) => (circulating > 0n ? Number((v * 10000n) / circulating) / 100 : 0);
  const top1 = holders[0] ? pct(holders[0][1]) : 0;
  const top10 = pct(holders.slice(0, 10).reduce((s, [, v]) => s + v, 0n));
  const creatorBal = creator ? (bal.get(creator) ?? 0n) : 0n;
  const creatorShare = opts.totalSupply > 0n && creator ? Number((creatorBal * 10000n) / opts.totalSupply) / 100 : "unknown" as const;
  const soldPct = creator && creatorReceived > 0n ? Number((creatorSentToPool * 10000n) / creatorReceived) / 100 : creator ? 0 : "unknown" as const;
  const airdropped = holders.filter(([a]) => receivedNotFromPool.has(a)).length;
  return {
    count: holders.length,
    top1_pct_ex_creator: top1,
    top10_pct_ex_creator: top10,
    airdrop_received_ratio: holders.length ? airdropped / holders.length : 0,
    transfers_from_creator: transfersFromCreator,
    creator_share_pct: creatorShare as U<number>,
    creator_sold_pct: soldPct as U<number>,
    creator_sold_any: creator ? creatorSentToPool > 0n : ("unknown" as const),
    top20: holders.slice(0, 20).map(([a]) => a),
    balances: bal,
  };
}

export function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

export function swapStats(swaps: SwapRec[], opts: { launchTs: number; nowTs: number; liquidityNative: number | null; launchPriceNative: number | null }) {
  const minutes = Math.max((opts.nowTs - opts.launchTs) / 60_000, 1 / 60);
  const buys = swaps.filter((s) => s.isBuy), sells = swaps.filter((s) => !s.isBuy);
  const buyVol = buys.reduce((s, x) => s + x.native, 0), sellVol = sells.reduce((s, x) => s + x.native, 0);
  const buyersByAddr = new Map<string, number>();
  for (const b of buys) buyersByAddr.set(lc(b.buyer), (buyersByAddr.get(lc(b.buyer)) ?? 0) + 1);
  const unique = buyersByAddr.size;
  const returning = [...buyersByAddr.values()].filter((n) => n > 1).length;
  // gyorsulás: utolsó harmad egyedi vevői / első harmad egyedi vevői
  const t1 = opts.launchTs + (opts.nowTs - opts.launchTs) / 3, t2 = opts.launchTs + (2 * (opts.nowTs - opts.launchTs)) / 3;
  const u = (from: number, to: number) => new Set(buys.filter((b) => b.ts >= from && b.ts < to).map((b) => lc(b.buyer))).size;
  const early = u(opts.launchTs, t1), late = u(t2, opts.nowTs + 1);
  const accel = early > 0 ? late / early : late > 0 ? 2 : 1;
  const prices = swaps.map((s) => s.priceNative).filter((p): p is number => p !== null && p > 0);
  const last = prices.at(-1) ?? null;
  const peak = prices.length ? Math.max(...prices) : null;
  const first = opts.launchPriceNative ?? prices[0] ?? null;
  const rets: number[] = [];
  for (let i = 1; i < prices.length; i++) rets.push(Math.log(prices[i]! / prices[i - 1]!));
  const vol = rets.length ? Math.sqrt(rets.reduce((s, r) => s + r * r, 0) / rets.length) * 100 : null;
  const sizes = buys.map((b) => b.native);
  const largest = sizes.length ? Math.max(...sizes) : 0;
  const largeSells = opts.liquidityNative ? sells.filter((s) => s.native > 0.05 * opts.liquidityNative!).length : "unknown" as const;
  return {
    buys: buys.length, sells: sells.length, buy_volume_native: buyVol, sell_volume_native: sellVol,
    buys_per_min: buys.length / minutes, sells_per_min: sells.length / minutes,
    buy_sell_ratio: sells.length ? buys.length / sells.length : buys.length,
    net_inflow_native: buyVol - sellVol,
    unique_buyers: unique, unique_buyers_per_min: unique / minutes, returning_buyers: returning, buyer_acceleration: accel,
    avg_buy_native: sizes.length ? buyVol / sizes.length : "unknown" as const,
    median_buy_native: median(sizes) ?? ("unknown" as const),
    largest_buy_pct_of_liquidity: opts.liquidityNative && opts.liquidityNative > 0 ? (largest / opts.liquidityNative) * 100 : "unknown" as const,
    price_native: last ?? ("unknown" as const),
    price_change_pct_since_launch: first && last ? ((last - first) / first) * 100 : "unknown" as const,
    peak_drawdown_pct: peak && last ? ((peak - last) / peak) * 100 : "unknown" as const,
    volatility_pct: vol ?? ("unknown" as const),
    large_sells: largeSells as U<number>,
  };
}

/** sqrtPriceX96 → token ára a párban (ETH/token), decimals-korrigálva. */
export function priceFromSqrtX96(sqrtPriceX96: bigint, tokenIsCurrency0: boolean, tokenDecimals: number, quoteDecimals = 18): number {
  const q = Number(sqrtPriceX96) / 2 ** 96;
  const p1per0 = q * q; // currency1 / currency0 nyers arány
  const raw = tokenIsCurrency0 ? p1per0 : 1 / p1per0;
  return raw * 10 ** (tokenDecimals - quoteDecimals);
}

/** 4 bájtos szelektorok keresése a bytecode-ban (PUSH4 = 0x63 utáni 4 bájt). Közelítés. */
export const DANGEROUS_SELECTORS: Record<string, string> = {
  "40c10f19": "mint(address,uint256)",
  "a0712d68": "mint(uint256)",
  "8456cb59": "pause()",
  "3f4ba83a": "unpause()",
  "f9f92be4": "blacklist(address)",
  "44337ea1": "removeFromBlacklist(address)",
  "1ab99e12": "setBlacklist(address,bool)",
  "0e136b19": "setBots(address[],bool)",
  "b515566a": "setBots(address[])",
  "e8078d94": "setTaxes(uint256,uint256)",
  "d54ad2a1": "setFees(uint256,uint256)",
  "afa4f3b2": "setMaxTxAmount(uint256)",
  "751039fc": "removeLimits()",
  "c9567bf9": "openTrading()",
  "8a8c523c": "enableTrading()",
};
export function findDangerousSelectors(bytecode: `0x${string}`): string[] {
  const hex = bytecode.slice(2).toLowerCase();
  const found = new Set<string>();
  for (let i = 0; i + 10 <= hex.length; i += 2) {
    if (hex.slice(i, i + 2) === "63") {
      const sel = hex.slice(i + 2, i + 10);
      if (DANGEROUS_SELECTORS[sel]) found.add(DANGEROUS_SELECTORS[sel]!);
    }
  }
  return [...found].sort();
}
