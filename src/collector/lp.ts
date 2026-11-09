import { type Address, type PublicClient, isAddressEqual } from "viem";
import { uniswapV4ModifyLiquidityAbi, erc721OwnerOfAbi } from "../abis/pools.js";

/**
 * Ki tudja kihúzni egy Uniswap v4 pool likviditását?
 *  burned   – a pozíció égetési címen (0x0 / 0x…dEaD)
 *  creator  – a készítő saját tárcája birtokolja → bármikor kihúzhatja
 *  eoa      – más, nem-szerződés tárca birtokolja → szintén kihúzható
 *  contract – szerződés birtokolja (zároló, hook vagy saját szerződés – nem eldönthető)
 *  removed  – a likviditás már kikerült a poolból
 *  none     – nem találtunk likviditás-hozzáadást
 */
export type LpOwnerKind = "burned" | "creator" | "eoa" | "contract" | "removed" | "none";

export interface LiqEvent { sender: Address; salt: `0x${string}`; delta: bigint; lower?: number; upper?: number }

const BURN = ["0x0000000000000000000000000000000000000000", "0x000000000000000000000000000000000000dEaD"] as const;
export const isBurn = (a: string) => BURN.some((b) => isAddressEqual(a as Address, b));

/** A legnagyobb nettó pozíció (sender + salt) kiválasztása; null, ha nincs pozitív nettó likviditás. */
export function largestPosition(events: LiqEvent[]): { sender: Address; salt: `0x${string}`; net: bigint; everAdded: boolean } | null {
  const by = new Map<string, { sender: Address; salt: `0x${string}`; net: bigint }>();
  let everAdded = false;
  for (const e of events) {
    if (e.delta > 0n) everAdded = true;
    const k = `${e.sender.toLowerCase()}|${e.salt}`;
    const cur = by.get(k) ?? { sender: e.sender, salt: e.salt, net: 0n };
    cur.net += e.delta; by.set(k, cur);
  }
  const best = [...by.values()].sort((a, b) => (b.net > a.net ? 1 : b.net < a.net ? -1 : 0))[0];
  if (!best) return null;
  return { ...best, everAdded };
}

/** Tulajdonos → kategória (a kód-lekérdezés kívülről jön, hogy tesztelhető legyen). */
export function classifyOwner(owner: Address, creator: Address | null, ownerHasCode: boolean): LpOwnerKind {
  if (isBurn(owner)) return "burned";
  if (creator && isAddressEqual(owner, creator)) return "creator";
  return ownerHasCode ? "contract" : "eoa";
}

/** A pool összes likviditás-eseménye (ModifyLiquidity) a megadott blokktartományon. */
export async function fetchLiqEvents(c: PublicClient, poolManager: Address, poolId: `0x${string}`,
  getLogs: (fetch: (f: bigint, t: bigint) => Promise<LiqEvent[]>) => Promise<LiqEvent[]>): Promise<LiqEvent[]> {
  return getLogs(async (f, t) => {
    const logs = await c.getLogs({ address: poolManager, event: uniswapV4ModifyLiquidityAbi[0], args: { id: poolId }, fromBlock: f, toBlock: t });
    return logs.map((l) => ({ sender: l.args.sender!, salt: l.args.salt!, delta: l.args.liquidityDelta!, lower: l.args.tickLower!, upper: l.args.tickUpper! }));
  });
}

export interface LiqPos { lower: number; upper: number; liquidity: bigint }
/** Nettó pozíciók (küldő + salt + ársáv szerint összegezve), csak a pozitív maradékok. */
export function positionsFromEvents(events: LiqEvent[]): LiqPos[] {
  const m = new Map<string, LiqPos>();
  for (const e of events) {
    if (e.lower === undefined || e.upper === undefined) continue;
    const k = `${e.sender.toLowerCase()}|${e.salt}|${e.lower}|${e.upper}`;
    const cur = m.get(k) ?? { lower: e.lower, upper: e.upper, liquidity: 0n };
    cur.liquidity += e.delta; m.set(k, cur);
  }
  return [...m.values()].filter((p) => p.liquidity > 0n);
}

/**
 * VALÓDI ETH a pool pozícióiban az aktuális áron (Uniswap v3/v4 pozíció-képletek).
 * Az egyoldalú (csak token) indításoknál a virtuális tartalék (L/√P) sokszorosan túlbecsülné az eladóknak elérhető ETH-t;
 * itt csak az van benne, ami ténylegesen ETH-ként ül a sávokban. ETH = currency0: L·(√Pb − max(√Pa,√P)) / (max(√Pa,√P)·√Pb),
 * ha √P < √Pb; ETH = currency1: L·(min(√P,√Pb) − √Pa), ha √P > √Pa. √P(tick) = 1,0001^(tick/2).
 */
export function nativeInPositions(pos: LiqPos[], sqrtPriceX96: bigint, nativeIsCurrency0: boolean): number {
  const sp = Number(sqrtPriceX96) / 2 ** 96;
  if (!(sp > 0)) return 0;
  let raw = 0;
  for (const p of pos) {
    const sa = Math.pow(1.0001, p.lower / 2), sb = Math.pow(1.0001, p.upper / 2), L = Number(p.liquidity);
    if (nativeIsCurrency0) { if (sp < sb) { const lo = Math.max(sa, sp); raw += (L * (sb - lo)) / (lo * sb); } }
    else if (sp > sa) raw += L * (Math.min(sp, sb) - sa);
  }
  return Number.isFinite(raw) ? raw / 1e18 : 0;
}

export async function lpOwner(
  c: PublicClient, poolManager: Address, poolId: `0x${string}`, creator: Address | null,
  getLogs: (fetch: (f: bigint, t: bigint) => Promise<LiqEvent[]>) => Promise<LiqEvent[]>, pre?: LiqEvent[],
): Promise<{ kind: LpOwnerKind; owner: Address | null }> {
  const events = pre ?? await fetchLiqEvents(c, poolManager, poolId, getLogs);
  const pos = largestPosition(events);
  if (!pos || !pos.everAdded) return { kind: "none", owner: null };
  if (pos.net <= 0n) return { kind: "removed", owner: null };
  const hasCode = async (a: Address) => { const code = await c.getCode({ address: a }).catch(() => undefined); return !!code && code !== "0x"; };
  let owner: Address = pos.sender;
  if (await hasCode(pos.sender)) {
    // PositionManager-szerű NFT-kezelő: a pozíció tulajdonosa az NFT gazdája (salt = tokenId)
    const nftOwner = await c.readContract({ address: pos.sender, abi: erc721OwnerOfAbi, functionName: "ownerOf", args: [BigInt(pos.salt)] }).catch(() => null);
    if (nftOwner) owner = nftOwner as Address;
    else return { kind: classifyOwner(pos.sender, creator, true), owner: pos.sender };
  }
  return { kind: classifyOwner(owner, creator, await hasCode(owner)), owner };
}
