import { keccak256, getAddress, type PublicClient } from "viem";
import type { DB } from "../db/index.js";

/**
 * Reaktív kihúzó gyárak szűrője (2026-10-08). Lelet: egy gyár percenként friss tárcákkal indít tokeneket ugyanabból a kódsablonból,
 * egy csali-szerződésen (0xa3e0e540…) át „bálna-vételt” csinál, és ha kívülálló vesz, 2–3 blokkon belül (egy másik szerződésen át)
 * kihúzza a likviditást. Ha senki nem vesz, az ár a csali-vételektől 2×-ig fut – ezért az árnyék ezeket NYERŐNEK látja (bnb_all60
 * pluszának egésze innen jött; a gyár nélkül −0,25). Szűrő: a token kódjának keccak-ja vagy a jelző (≥1 BNB-s) vétel tx.to-ja listán.
 * A lista önfrissítő: élő pozíció 30 mp-en belüli kiürülése → a token kódsablonja és (ha nem a PancakeSwap router) a csali-szerződés.
 */
const ROUTER = "0x10ed43c718714eb63d5aa57b78b54704e256024e";
export const QUICK_RUG_MS = 30_000;

export async function tokenCodeHash(c: PublicClient, token: string): Promise<string | null> {
  try { const code = await c.getCode({ address: getAddress(token) }); return code && code !== "0x" ? keccak256(code) : null; } catch { return null; }
}
/** A pár legutóbbi ≥ 1 BNB-s vételének tx.to-ja (a csali-szerződés), `beforeAt` előtt; ha nincs ilyen, null. */
export async function whaleVia(c: PublicClient, db: DB, pair: string, beforeAt: number): Promise<string | null> {
  const w = db.prepare("SELECT tx FROM bnb_pair_trades WHERE pair = ? AND side = 'buy' AND bnb >= 1 AND at <= ? ORDER BY at DESC LIMIT 1").get(pair.toLowerCase(), beforeAt) as { tx: string } | undefined;
  if (!w) return null;
  try { const tx = await c.getTransaction({ hash: w.tx as `0x${string}` }); return (tx.to ?? "").toLowerCase() || null; } catch { return null; }
}
export function isReactive(db: DB, codeHash: string | null, via: string | null): string | null {
  if (codeHash && db.prepare("SELECT 1 FROM bnb_reactive_marks WHERE kind = 'code' AND value = ?").get(codeHash)) return "kódsablon";
  if (via && via !== ROUTER && db.prepare("SELECT 1 FROM bnb_reactive_marks WHERE kind = 'via' AND value = ?").get(via)) return "csali-szerződés";
  return null;
}
export function markReactive(db: DB, pair: string, codeHash: string | null, via: string | null, now = Date.now()): number {
  const ins = db.prepare("INSERT OR IGNORE INTO bnb_reactive_marks(kind, value, pair, added_at) VALUES (?,?,?,?)");
  let n = 0;
  if (codeHash) n += ins.run("code", codeHash, pair.toLowerCase(), now).changes;
  if (via && via !== ROUTER) n += ins.run("via", via, pair.toLowerCase(), now).changes;
  return n;
}
