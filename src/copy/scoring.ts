import type { DB } from "../db/index.js";

/**
 * Tárcapontozás a saját megfigyelt kereskedésekből (csak a követett friss tokenek körében):
 * tokenenként „lezárt kör”, ha a tárca a vett mennyiség legalább 90%-át eladta; eredmény = kapott − kiadott ETH.
 *  smart     – legalább minClosed lezárt kör, nyerő arány ≥ minWinRate, összesített eredmény > 0
 *  unskilled – legalább minClosed lezárt kör, összesített eredmény ≤ 0 (kontroll: ugyanúgy tapasztalt, de nem nyerő)
 * Csak a pontozás pillanatáig megtörtént kereskedéseket látja, ezért egy későbbi belépés nem „néz előre”.
 */
export type WalletClass = "smart" | "unskilled";
export interface WalletScore { wallet: string; closed: number; wins: number; pnl: number; cls: WalletClass | null }

export function scoreWallets(db: DB, chain: string, o: { minClosed: number; minWinRate: number; untilMs?: number }): Map<string, WalletScore> {
  const until = o.untilMs ?? Date.now();
  const rows = db.prepare(`SELECT wallet, token_id,
      SUM(CASE WHEN is_buy=1 THEN native ELSE 0 END) bn, SUM(CASE WHEN is_buy=0 THEN native ELSE 0 END) sn,
      SUM(CASE WHEN is_buy=1 THEN tokens ELSE 0 END) bt, SUM(CASE WHEN is_buy=0 THEN tokens ELSE 0 END) st
    FROM wallet_trades WHERE chain = ? AND at <= ? GROUP BY wallet, token_id`).all(chain, until) as Array<{ wallet: string; bn: number; sn: number; bt: number; st: number }>;
  const out = new Map<string, WalletScore>();
  for (const r of rows) {
    if (!(r.bt > 0) || r.st < 0.9 * r.bt) continue; // csak lezárt kör számít
    const s = out.get(r.wallet) ?? { wallet: r.wallet, closed: 0, wins: 0, pnl: 0, cls: null };
    const pnl = r.sn - r.bn;
    s.closed++; s.pnl += pnl; if (pnl > 0) s.wins++;
    out.set(r.wallet, s);
  }
  for (const s of out.values()) {
    if (s.closed < o.minClosed) continue;
    if (s.pnl > 0 && s.wins / s.closed >= o.minWinRate) s.cls = "smart";
    else if (s.pnl <= 0) s.cls = "unskilled";
  }
  return out;
}
