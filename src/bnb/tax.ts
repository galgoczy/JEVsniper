import { decodeEventLog, parseAbi, type PublicClient, type Hex } from "viem";

/**
 * BSC token-adó mérése a láncról (2026-10-07): valódi vételek és eladások nyugtáiból.
 *  - Vételi adó: a pár Swap-ja szerint kiküldött token (amountOut) vs. amennyivel a címzett (Swap.to) egyenlege a tx-ben nőtt
 *    (Σ Transfer(→címzett) − Σ Transfer(címzett→)). adó = 1 − kapott / kiküldött.
 *  - Eladási adó: az eladó által elküldött token (Σ Transfer(eladó→)) vs. amennyit a pár ténylegesen kapott (Swap amountIn).
 *    Az eladó = aki a legnagyobb Transfer-t küldte a párba. adó = 1 − pár kapta / eladó küldte.
 * Ha a címzett aggregátor/szerződés, amely a tx-en belül továbbküldi (nettó 0), az a minta nem mérhető (kimarad).
 * A minták mediánja; 0 és 1 közé vágva.
 */
const ABI = parseAbi([
  "event Transfer(address indexed from, address indexed to, uint256 value)",
  "event Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)",
]);
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

export interface TaxResult { buyTax: number | null; sellTax: number | null; nBuy: number; nSell: number }
const median = (a: number[]) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2; };
const clip = (x: number) => Math.min(1, Math.max(0, x));

export function taxFromReceipt(logs: Array<{ address: string; topics: readonly Hex[]; data: Hex }>, pair: string, token: string, wbnbIs0: boolean, side: "buy" | "sell"): number | null {
  pair = pair.toLowerCase(); token = token.toLowerCase();
  const transfers: Array<{ from: string; to: string; v: bigint }> = [];
  let swap: { in: bigint; out: bigint; to: string } | null = null;
  for (const l of logs) {
    const a = l.address.toLowerCase();
    try {
      if (a === token && l.topics[0] === TRANSFER) { const d = decodeEventLog({ abi: ABI, data: l.data, topics: l.topics as [Hex, ...Hex[]] }); const x = d.args as { from: string; to: string; value: bigint }; transfers.push({ from: x.from.toLowerCase(), to: x.to.toLowerCase(), v: x.value }); }
      else if (a === pair) { const d = decodeEventLog({ abi: ABI, data: l.data, topics: l.topics as [Hex, ...Hex[]] }); if (d.eventName === "Swap") { const x = d.args as { amount0In: bigint; amount1In: bigint; amount0Out: bigint; amount1Out: bigint; to: string };
        swap = { in: wbnbIs0 ? x.amount1In : x.amount0In, out: wbnbIs0 ? x.amount1Out : x.amount0Out, to: x.to.toLowerCase() }; } }
    } catch { /* nem ez az esemény */ }
  }
  if (!swap) return null;
  if (side === "buy") {
    if (!(swap.out > 0n)) return null;
    const r = swap.to; let net = 0n;
    for (const t of transfers) { if (t.to === r) net += t.v; if (t.from === r) net -= t.v; }
    if (net <= 0n || net > swap.out) return null; // aggregátor / továbbküldés → nem mérhető
    return clip(1 - Number(net) / Number(swap.out));
  }
  if (!(swap.in > 0n)) return null;
  const intoPair = transfers.filter((t) => t.to === pair).sort((a, b) => (b.v > a.v ? 1 : -1))[0]; if (!intoPair) return null;
  const seller = intoPair.from; if (seller === pair || seller === token) return null;
  const sent = transfers.filter((t) => t.from === seller).reduce((s, t) => s + t.v, 0n);
  if (sent <= 0n || swap.in > sent) return null;
  return clip(1 - Number(swap.in) / Number(sent));
}

export async function measureTax(client: PublicClient, pair: string, token: string, wbnbIs0: boolean, trades: Array<{ tx: string; side: "buy" | "sell" }>, perSide = 3): Promise<TaxResult> {
  const pick = (side: "buy" | "sell") => [...new Set(trades.filter((t) => t.side === side).map((t) => t.tx))].slice(0, perSide);
  const one = async (tx: string, side: "buy" | "sell") => { try { const r = await client.getTransactionReceipt({ hash: tx as Hex }); return r.status === "success" ? taxFromReceipt(r.logs as never, pair, token, wbnbIs0, side) : null; } catch { return null; } };
  const [b, s] = await Promise.all([Promise.all(pick("buy").map((tx) => one(tx, "buy"))), Promise.all(pick("sell").map((tx) => one(tx, "sell")))]);
  const bv = b.filter((x): x is number => x !== null), sv = s.filter((x): x is number => x !== null);
  return { buyTax: median(bv), sellTax: median(sv), nBuy: bv.length, nSell: sv.length };
}

/** Adóval korrigált nettó (USD): a kapott BNB a (1−vételi)(1−eladási) szorzóval csökken. Ismeretlen adó → null. */
export function taxedNet(netUsd: number, sizeUsd: number, txs: number, gasUsd: number, buyTax: number | null, sellTax: number | null): number | null {
  if (buyTax === null || sellTax === null) return null;
  const recvUsd = netUsd + sizeUsd + txs * gasUsd;
  return netUsd - recvUsd * (1 - (1 - buyTax) * (1 - sellTax));
}
