import { type Address, type PublicClient, getAddress } from "viem";
import type { DB } from "../db/index.js";
import type { ChainKey } from "../chains/index.js";
import { ADDRESSES } from "../chains/addresses.js";
import { ponsCurveAbi } from "../abis/pons.js";
import { uniswapV4SwapAbi } from "../abis/pools.js";
import { erc20WriteAbi } from "../abis/uniswapV4.js";
import { priceFromSqrtX96 } from "../collector/stats.js";
import { log } from "../logger.js";

export interface Tracked { tokenId: number; token: Address; mechanics: string; pool: string | null; creator: Address | null; decimals: number; pairToken: string | null }
export interface PriceState { price: number; at: number; block: bigint; liquidityNative: number | null; creatorBalance: number | null; swapsSinceLast: number; sellsSinceLast: number; graduated: boolean }

/**
 * Kötegelt árfolyam-követés láncenként: a nyitott pozíciók és a 24 órás kimenet-követés tokenjeire
 *  - v4 poolok: PoolManager Swap események poolId-listával (egy getLogs 200-as adagokban) → sqrtPriceX96
 *  - PONS curve-ök: multicall (quoteReserve, tokenReserve, graduated) → ár + likviditás; események a forgalomhoz
 *  - creator egyenlege: multicall balanceOf
 * Blokkonként fut (a monitor tick-jén), Jev nélkül – ez a vészfékek alapja.
 */
export class PriceFeed {
  private state = new Map<number, PriceState>();
  private lastBlock: bigint | null = null;
  constructor(private chain: ChainKey, private client: PublicClient, private db: DB) {}

  get(tokenId: number): PriceState | undefined { return this.state.get(tokenId); }

  async refresh(tracked: Tracked[]): Promise<void> {
    if (!tracked.length) return;
    const head = await this.client.getBlockNumber();
    const from = this.lastBlock === null ? head - 50n : this.lastBlock + 1n;
    const A = ADDRESSES[this.chain];
    const now = Date.now();
    const bump = (id: number, patch: Partial<PriceState>) => {
      const cur = this.state.get(id) ?? { price: 0, at: 0, block: 0n, liquidityNative: null, creatorBalance: null, swapsSinceLast: 0, sellsSinceLast: 0, graduated: false };
      this.state.set(id, { ...cur, ...patch });
    };
    for (const t of tracked) { const cur = this.state.get(t.tokenId); if (cur) { cur.swapsSinceLast = 0; cur.sellsSinceLast = 0; } }

    // --- PONS curve-ök: reserves multicall
    const curves = tracked.filter((t) => t.mechanics === "bonding_curve" && t.pool && /^0x[0-9a-fA-F]{40}$/.test(t.pool));
    if (curves.length) {
      const contracts = curves.flatMap((t) => (["quoteReserve", "tokenReserve", "graduated"] as const).map((fn) => ({ address: getAddress(t.pool!), abi: ponsCurveAbi, functionName: fn })));
      const mc = (await this.client.multicall({ allowFailure: true, contracts: contracts as never }).catch((e) => { log.debug("pricefeed curve multicall hiba", { error: (e as Error).message.slice(0, 100) }); return null; })) as Array<{ status: string; result?: unknown }> | null;
      if (mc) curves.forEach((t, i) => {
        const q = mc[i * 3]?.status === "success" ? (mc[i * 3]!.result as bigint) : null;
        const tk = mc[i * 3 + 1]?.status === "success" ? (mc[i * 3 + 1]!.result as bigint) : null;
        const g = mc[i * 3 + 2]?.status === "success" ? (mc[i * 3 + 2]!.result as boolean) : false;
        if (q !== null && tk !== null && tk > 0n) bump(t.tokenId, { price: Number(q) / Number(tk) * 10 ** (t.decimals - 18), liquidityNative: Number(q) / 1e18, at: now, block: head, graduated: g });
      });
      if (head >= from) {
        const ev = ponsCurveAbi.filter((x) => x.type === "event");
        const logs = await this.client.getLogs({ address: curves.map((t) => getAddress(t.pool!)), events: ev, fromBlock: from, toBlock: head }).catch(() => []);
        const byCurve = new Map(curves.map((t) => [t.pool!.toLowerCase(), t.tokenId]));
        for (const l of logs as unknown as Array<{ address: string; eventName: string }>) {
          const id = byCurve.get(l.address.toLowerCase()); if (id === undefined) continue;
          const cur = this.state.get(id); if (!cur) continue;
          cur.swapsSinceLast++; if (l.eventName === "CurveSell") cur.sellsSinceLast++;
        }
      }
    }

    // --- v4 poolok: Swap események poolId szerint (200-as adagok)
    const v4 = tracked.filter((t) => (t.mechanics === "v4" || t.mechanics === "v4_hook" || (t.mechanics === "bonding_curve" && this.state.get(t.tokenId)?.graduated)) && t.pool && t.pool.length === 66);
    if (v4.length && A.uniswapV4PoolManager && head >= from) {
      const byId = new Map(v4.map((t) => [t.pool!.toLowerCase(), t]));
      for (let i = 0; i < v4.length; i += 200) {
        const ids = v4.slice(i, i + 200).map((t) => t.pool as `0x${string}`);
        const logs = await this.client.getLogs({ address: A.uniswapV4PoolManager, event: uniswapV4SwapAbi[0], args: { id: ids }, fromBlock: from, toBlock: head }).catch((e) => { log.debug("pricefeed v4 getLogs hiba", { error: (e as Error).message.slice(0, 100) }); return []; });
        for (const l of logs) {
          const t = byId.get((l.args.id as string).toLowerCase()); if (!t) continue;
          const tokenIsC0 = BigInt(t.token) < BigInt(t.pairToken ?? "0x0000000000000000000000000000000000000000");
          const price = priceFromSqrtX96(l.args.sqrtPriceX96!, tokenIsC0, t.decimals);
          const tokenAmt = tokenIsC0 ? l.args.amount0! : l.args.amount1!;
          const cur = this.state.get(t.tokenId);
          bump(t.tokenId, { price, at: now, block: l.blockNumber!, swapsSinceLast: (cur?.swapsSinceLast ?? 0) + 1, sellsSinceLast: (cur?.sellsSinceLast ?? 0) + (tokenAmt > 0n ? 1 : 0) });
        }
      }
    }

    // --- creator egyenlegek
    const withCreator = tracked.filter((t) => t.creator);
    if (withCreator.length) {
      const mc = (await this.client.multicall({ allowFailure: true, contracts: withCreator.map((t) => ({ address: t.token, abi: erc20WriteAbi, functionName: "balanceOf", args: [t.creator!] })) as never }).catch(() => null)) as Array<{ status: string; result?: unknown }> | null;
      if (mc) withCreator.forEach((t, i) => { if (mc[i]?.status === "success") bump(t.tokenId, { creatorBalance: Number(mc[i]!.result as bigint) / 10 ** t.decimals }); });
    }
    this.lastBlock = head;
  }
}
