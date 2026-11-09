import type { DB } from "../db/index.js";

/**
 * Hány korábbi, ugyanilyen szerződéskódú (bytecode_hash) tokennél húzták ki teljesen a likviditást
 * (bármelyik kar pozíciója 'emergency:liquidity_drop_-100%' okkal zárult). 0, ha a kód ismeretlen vagy egyedi.
 * A hash a DB-ből jön, mert a gyűjtő a pillanatkép közben írja be (a TokenRow lehet régebbi).
 */
export function factoryRugCount(db: DB, tokenId: number): number {
  const row = db.prepare("SELECT bytecode_hash FROM tokens WHERE id = ?").get(tokenId) as { bytecode_hash: string | null } | undefined;
  const hash = row?.bytecode_hash;
  if (!hash || hash === "0x") return 0;
  return (db.prepare(`SELECT COUNT(DISTINCT t.id) n FROM tokens t JOIN positions p ON p.token_id = t.id
    WHERE t.bytecode_hash = ? AND t.id != ? AND p.close_reason LIKE 'emergency:liquidity_drop_-100%'`).get(hash, tokenId) as { n: number }).n;
}
