import { type Address, type PublicClient, getAddress } from "viem";
import type { DB } from "../db/index.js";
import type { ChainKey } from "../chains/index.js";
import { ADDRESSES } from "../chains/addresses.js";
import { ponsCurveAbi } from "../abis/pons.js";
import { uniswapV4SwapAbi } from "../abis/pools.js";
import { erc20WriteAbi } from "../abis/uniswapV4.js";
import { priceFromSqrtX96, v4NativeReserve } from "../collector/stats.js";
import { uniswapV4ModifyLiquidityAbi } from "../abis/pools.js";
import { nativeInPositions, type LiqPos } from "../collector/lp.js";
import { log } from "../logger.js";
import { computePoolId, type PoolKey } from "../exec/routes.js";

export interface Tracked { tokenId: number; token: Address; mechanics: string; pool: string | null; creator: Address | null; decimals: number; pairToken: string | null; poolKeyJson?: string | null; graduatedAt?: number | null; discoveredBlock?: number | null }
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
  /** v4 pozíciók tokenenként (valódi ETH-tartalékhoz); null = túl régi a visszatöltéshez → virtuális tartalék */
  private liqPos = new Map<number, Map<string, LiqPos> | null>();
  private lastSqrt = new Map<number, { sqrt: bigint; nativeIsC0: boolean }>();
  private lastBlock: bigint | null = null;
  constructor(private chain: ChainKey, private client: PublicClient, private db: DB) {}

  get(tokenId: number): PriceState | undefined { return this.state.get(tokenId); }

  /**
   * v4 pozíciók karbantartása: új tokennél visszatöltés a felfedezés blokkjától (legfeljebb 20 000 blokk), utána
   * minden körben az új ModifyLiquidity események. Likviditás-kivételnél (swap nélkül is) frissül a valódi tartalék.
   */
  private async updatePositions(v4: Array<{ t: Tracked; id: `0x${string}` }>, byId: Map<string, Tracked>, from: bigint, head: bigint, pm: Address) {
    const apply = (tokenId: number, e: { sender: string; salt: string; lower: number; upper: number; delta: bigint }) => {
      const m = this.liqPos.get(tokenId); if (!m) return;
      const k = `${e.sender.toLowerCase()}|${e.salt}|${e.lower}|${e.upper}`;
      const cur = m.get(k) ?? { lower: e.lower, upper: e.upper, liquidity: 0n };
      cur.liquidity += e.delta; if (cur.liquidity > 0n) m.set(k, cur); else m.delete(k);
    };
    const ev = uniswapV4ModifyLiquidityAbi[0];
    const step = this.chain === "base" ? 2000n : 500n;
    for (const { t, id } of v4) {
      if (this.liqPos.has(t.tokenId)) continue;
      // Visszatöltés a felfedezés blokkjától; ha az túl régi (> 20 000 blokk), az utolsó 20 000 blokkból – ez akkor teljes,
      // ha a pool is ezen belül jött létre (pl. friss graduáció). Ha így egyetlen likviditás-hozzáadás sem látszik, nincs mire
      // építeni → virtuális becslés marad (null).
      const disc = t.discoveredBlock ? BigInt(t.discoveredBlock) : null;
      const start = disc !== null && head - disc <= 20_000n ? disc : head - 20_000n;
      const partial = disc === null || head - disc > 20_000n;
      this.liqPos.set(t.tokenId, new Map());
      try {
        for (let f = start; f < from; f += step + 1n) {
          const to = f + step >= from ? from - 1n : f + step;
          const logs = await this.client.getLogs({ address: pm, event: ev, args: { id }, fromBlock: f, toBlock: to });
          for (const l of logs) apply(t.tokenId, { sender: l.args.sender!, salt: l.args.salt!, lower: l.args.tickLower!, upper: l.args.tickUpper!, delta: l.args.liquidityDelta! });
        }
        if (partial && !(this.liqPos.get(t.tokenId)?.size)) this.liqPos.set(t.tokenId, null);
      } catch (e) { this.liqPos.set(t.tokenId, null); log.debug("pozíció-visszatöltés hiba", { error: (e as Error).message.slice(0, 100) }); }
    }
    const ids = v4.filter((x) => this.liqPos.get(x.t.tokenId)).map((x) => x.id);
    for (let i = 0; i < ids.length; i += 200) {
      const logs = await this.client.getLogs({ address: pm, event: ev, args: { id: ids.slice(i, i + 200) }, fromBlock: from, toBlock: head }).catch(() => []);
      const touched = new Set<number>();
      for (const l of logs) { const t = byId.get((l.args.id as string).toLowerCase()); if (!t) continue; apply(t.tokenId, { sender: l.args.sender!, salt: l.args.salt!, lower: l.args.tickLower!, upper: l.args.tickUpper!, delta: l.args.liquidityDelta! }); touched.add(t.tokenId); }
      for (const id of touched) { // likviditás-mozgás swap nélkül (pl. kihúzás): valódi tartalék az utolsó ismert áron
        const ls = this.lastSqrt.get(id), m = this.liqPos.get(id), cur = this.state.get(id);
        if (ls && m && cur) this.state.set(id, { ...cur, liquidityNative: nativeInPositions([...m.values()], ls.sqrt, ls.nativeIsC0) });
      }
    }
  }

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

    const isGraduated = (t: Tracked) => t.mechanics === "bonding_curve" && (!!t.graduatedAt || this.state.get(t.tokenId)?.graduated === true);
    // --- PONS curve-ök (csak amíg nem graduáltak): reserves multicall
    const curves = tracked.filter((t) => t.mechanics === "bonding_curve" && !isGraduated(t) && t.pool && /^0x[0-9a-fA-F]{40}$/.test(t.pool));
    if (curves.length) {
      const contracts = curves.flatMap((t) => (["quoteReserve", "tokenReserve", "graduated"] as const).map((fn) => ({ address: getAddress(t.pool!), abi: ponsCurveAbi, functionName: fn })));
      const mc = (await this.client.multicall({ allowFailure: true, contracts: contracts as never }).catch((e) => { log.debug("pricefeed curve multicall hiba", { error: (e as Error).message.slice(0, 100) }); return null; })) as Array<{ status: string; result?: unknown }> | null;
      if (mc) curves.forEach((t, i) => {
        const q = mc[i * 3]?.status === "success" ? (mc[i * 3]!.result as bigint) : null;
        const tk = mc[i * 3 + 1]?.status === "success" ? (mc[i * 3 + 1]!.result as bigint) : null;
        const g = mc[i * 3 + 2]?.status === "success" ? (mc[i * 3 + 2]!.result as boolean) : false;
        if (g) bump(t.tokenId, { graduated: true, liquidityNative: null }); // graduált: az ár a v4 poolból (lent), a curve-tartalék nem érvényes
        else if (q !== null && tk !== null && tk > 0n) bump(t.tokenId, { price: Number(q) / Number(tk) * 10 ** (t.decimals - 18), liquidityNative: Number(q) / 1e18, at: now, block: head, graduated: false });
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
    const v4 = tracked.map((t) => {
      if ((t.mechanics === "v4" || t.mechanics === "v4_hook") && t.pool && t.pool.length === 66) return { t, id: t.pool as `0x${string}` };
      if (isGraduated(t) && t.poolKeyJson) return { t, id: computePoolId(JSON.parse(t.poolKeyJson) as PoolKey) };
      return null;
    }).filter((x): x is { t: Tracked; id: `0x${string}` } => x !== null);
    if (v4.length && A.uniswapV4PoolManager && head >= from) {
      const byId = new Map(v4.map((x) => [x.id.toLowerCase(), x.t]));
      await this.updatePositions(v4, byId, from, head, A.uniswapV4PoolManager);
      for (let i = 0; i < v4.length; i += 200) {
        const ids = v4.slice(i, i + 200).map((x) => x.id);
        const logs = await this.client.getLogs({ address: A.uniswapV4PoolManager, event: uniswapV4SwapAbi[0], args: { id: ids }, fromBlock: from, toBlock: head }).catch((e) => { log.debug("pricefeed v4 getLogs hiba", { error: (e as Error).message.slice(0, 100) }); return []; });
        for (const l of logs) {
          const t = byId.get((l.args.id as string).toLowerCase()); if (!t) continue;
          const tokenIsC0 = BigInt(t.token) < BigInt(t.pairToken ?? "0x0000000000000000000000000000000000000000");
          const price = priceFromSqrtX96(l.args.sqrtPriceX96!, tokenIsC0, t.decimals);
          const tokenAmt = tokenIsC0 ? l.args.amount0! : l.args.amount1!;
          const cur = this.state.get(t.tokenId);
          this.lastSqrt.set(t.tokenId, { sqrt: l.args.sqrtPriceX96!, nativeIsC0: !tokenIsC0 });
          const pos = this.liqPos.get(t.tokenId);
          const liq = pos ? nativeInPositions([...pos.values()], l.args.sqrtPriceX96!, !tokenIsC0) : v4NativeReserve(l.args.liquidity!, l.args.sqrtPriceX96!, !tokenIsC0);
          bump(t.tokenId, { price, at: now, block: l.blockNumber!, ...(liq !== null ? { liquidityNative: liq } : {}), swapsSinceLast: (cur?.swapsSinceLast ?? 0) + 1, sellsSinceLast: (cur?.sellsSinceLast ?? 0) + (tokenAmt < 0n ? 1 : 0) }); // v4: negatív token = a kereskedő adta = eladás
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
