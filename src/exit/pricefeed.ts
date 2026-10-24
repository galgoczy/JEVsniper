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

export interface Tracked { tokenId: number; token: Address; mechanics: string; pool: string | null; creator: Address | null; decimals: number; pairToken: string | null; poolKeyJson?: string | null; graduatedAt?: number | null; discoveredBlock?: number | null; graduationThreshold?: string | null }
export interface PriceState { price: number; at: number; block: bigint; liquidityNative: number | null; creatorBalance: number | null; swapsSinceLast: number; sellsSinceLast: number; graduated: boolean; curveProgressPct?: number | null }

/**
 * Kötegelt árfolyam-követés láncenként: a nyitott pozíciók és a 24 órás kimenet-követés tokenjeire
 *  - v4 poolok: PoolManager Swap események poolId-listával (egy getLogs 200-as adagokban) → sqrtPriceX96
 *  - PONS curve-ök: multicall (quoteReserve, tokenReserve, graduated) → ár + likviditás; események a forgalomhoz
 *  - creator egyenlege: multicall balanceOf
 * Blokkonként fut (a monitor tick-jén), Jev nélkül – ez a vészfékek alapja.
 */
/** Újraindítás utáni visszatöltés adagolása (2026-10-02): körönként ennyi token, ennyi párhuzamos szálon. */
const BACKFILL_PER_TICK = 30;
const BACKFILL_CONCURRENCY = 6;
/** átlagos blokkidő (mp) – a graduáció korának blokkra váltásához */
const BLOCK_SEC: Record<ChainKey, number> = { base: 2, robinhood: 0.26 };

export class PriceFeed {
  private state = new Map<number, PriceState>();
  /** v4 pozíciók tokenenként (valódi ETH-tartalékhoz); null = túl régi a visszatöltéshez → virtuális tartalék */
  private liqPos = new Map<number, Map<string, LiqPos> | null>();
  private lastSqrt = new Map<number, { sqrt: bigint; nativeIsC0: boolean }>();
  private lastBlock: bigint | null = null;
  /** visszatöltésre váró v4 tokenek (a következő körök adagjai) */
  private waiting = new Set<number>();
  constructor(private chain: ChainKey, private client: PublicClient, private db: DB) {}

  get(tokenId: number): PriceState | undefined { return this.state.get(tokenId); }

  /** Kész-e a token likviditás-visszatöltése (a még sorban álló v4 tokennél a valódi ETH ismeretlen → nem szabad értékelni). */
  ready(tokenId: number): boolean { return !this.waiting.has(tokenId); }

  /**
   * v4 pozíciók karbantartása: új tokennél visszatöltés a felfedezés blokkjától (legfeljebb 20 000 blokk), utána
   * minden körben az új ModifyLiquidity események. Likviditás-kivételnél (swap nélkül is) frissül a valódi tartalék.
   */
  private async updatePositions(v4: Array<{ t: Tracked; id: `0x${string}` }>, byId: Map<string, Tracked>, from: bigint, head: bigint, pm: Address) {
    const apply = (tokenId: number, e: { sender: string; salt: string; lower: number; upper: number; delta: bigint }, into?: Map<string, LiqPos>) => {
      const m = into ?? this.liqPos.get(tokenId); if (!m) return;
      const k = `${e.sender.toLowerCase()}|${e.salt}|${e.lower}|${e.upper}`;
      const cur = m.get(k) ?? { lower: e.lower, upper: e.upper, liquidity: 0n };
      cur.liquidity += e.delta; if (cur.liquidity > 0n) m.set(k, cur); else m.delete(k);
    };
    const ev = uniswapV4ModifyLiquidityAbi[0];
    const step = this.chain === "base" ? 2000n : 500n;
    // 2026-10-02: újraindításkor ezernyi token várt egyszerre, egyenként, sorban visszatöltésre (~10 getLogs/token) → az első
    // monitor-kör órákig tartott, közben egy pozíció sem zárult. Ezért: (1) régi, nem graduált tokennél nincs visszatöltés
    // (a pool létrehozása kiesik a 20 000 blokkból, úgyis virtuális becslés lenne); (2) körönként legfeljebb BACKFILL_PER_TICK
    // token, a legfrissebbek elöl, BACKFILL_CONCURRENCY párhuzamos szálon. A még nem töltött tokenek pozícióit a monitor
    // addig nem ellenőrzi (ready()), különben a kihúzott likviditást nem látná, és a kihúzás előtti áron „adna el”.
    const pending: Array<{ t: Tracked; id: `0x${string}` }> = [];
    for (const x of v4) {
      if (this.liqPos.has(x.t.tokenId)) continue;
      const disc = x.t.discoveredBlock ? BigInt(x.t.discoveredBlock) : null;
      const old = disc === null || head - disc > 20_000n;
      // graduált PONS-token: a v4 pool a graduációkor jött létre – ha az is régebbi a 20 000 blokknál, nincs mit visszatölteni
      const graduated = x.t.mechanics === "bonding_curve";
      const gradOld = graduated && !!x.t.graduatedAt && Date.now() - x.t.graduatedAt > 20_000 * BLOCK_SEC[this.chain] * 1000;
      if ((old && !graduated) || gradOld) { this.liqPos.set(x.t.tokenId, null); continue; }
      pending.push(x);
    }
    pending.sort((a, b) => (b.t.discoveredBlock ?? 0) - (a.t.discoveredBlock ?? 0));
    const batch = pending.slice(0, BACKFILL_PER_TICK);
    const backfill = async ({ t, id }: { t: Tracked; id: `0x${string}` }) => {
      // Visszatöltés a felfedezés blokkjától; ha az túl régi (> 20 000 blokk), az utolsó 20 000 blokkból – ez akkor teljes,
      // ha a pool is ezen belül jött létre (pl. friss graduáció). Ha így egyetlen likviditás-hozzáadás sem látszik, nincs mire
      // építeni → virtuális becslés marad (null).
      const disc = t.discoveredBlock ? BigInt(t.discoveredBlock) : null;
      const start = disc !== null && head - disc <= 20_000n ? disc : head - 20_000n;
      const partial = disc === null || head - disc > 20_000n;
      const m = new Map<string, LiqPos>();
      try {
        for (let f = start; f < from; f += step + 1n) {
          const to = f + step >= from ? from - 1n : f + step;
          const logs = await this.client.getLogs({ address: pm, event: ev, args: { id }, fromBlock: f, toBlock: to });
          for (const l of logs) apply(t.tokenId, { sender: l.args.sender!, salt: l.args.salt!, lower: l.args.tickLower!, upper: l.args.tickUpper!, delta: l.args.liquidityDelta! }, m);
        }
        this.liqPos.set(t.tokenId, partial && !m.size ? null : m);
      } catch (e) { this.liqPos.set(t.tokenId, null); log.debug("pozíció-visszatöltés hiba", { error: (e as Error).message.slice(0, 100) }); }
    };
    this.waiting = new Set(pending.slice(BACKFILL_PER_TICK).map((x) => x.t.tokenId));
    for (let i = 0; i < batch.length; i += BACKFILL_CONCURRENCY) await Promise.all(batch.slice(i, i + BACKFILL_CONCURRENCY).map(backfill));
    if (pending.length > batch.length) log.info(`likviditás-visszatöltés: még ${pending.length - batch.length} token vár (${this.chain})`);
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
        else if (q !== null && tk !== null && tk > 0n) {
          const thr = t.graduationThreshold ? BigInt(t.graduationThreshold) : 0n; // görbe haladása (graduáció előtti kar)
          bump(t.tokenId, { price: Number(q) / Number(tk) * 10 ** (t.decimals - 18), liquidityNative: Number(q) / 1e18, at: now, block: head, graduated: false,
            curveProgressPct: thr > 0n ? Math.min(100, Number((q * 10000n) / thr) / 100) : null });
        }
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
