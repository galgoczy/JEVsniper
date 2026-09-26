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

export interface LiqEvent { sender: Address; salt: `0x${string}`; delta: bigint }

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

export async function lpOwner(
  c: PublicClient, poolManager: Address, poolId: `0x${string}`, creator: Address | null,
  getLogs: (fetch: (f: bigint, t: bigint) => Promise<LiqEvent[]>) => Promise<LiqEvent[]>,
): Promise<{ kind: LpOwnerKind; owner: Address | null }> {
  const events = await getLogs(async (f, t) => {
    const logs = await c.getLogs({ address: poolManager, event: uniswapV4ModifyLiquidityAbi[0], args: { id: poolId }, fromBlock: f, toBlock: t });
    return logs.map((l) => ({ sender: l.args.sender!, salt: l.args.salt!, delta: l.args.liquidityDelta! }));
  });
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
