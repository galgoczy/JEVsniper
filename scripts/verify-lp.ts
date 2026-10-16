/**
 * LP-tulajdonos verify: a legutóbbi lezárt base_uni_all árnyékpozíciók tokenjeinél megnézi, ki birtokolja
 * (most) a v4 pool likviditását, és ki hozta létre a poolt. Csak olvas a láncról és az adatbázisból.
 * Futtatás: npm run verify:lp
 */
import { getAddress, type Address } from "viem";
import { loadConfig } from "../src/config.js";
import { loadEnv } from "../src/env.js";
import { openDb } from "../src/db/index.js";
import { publicClient } from "../src/chains/index.js";
import { ADDRESSES } from "../src/chains/addresses.js";
import { lpOwner, type LiqEvent } from "../src/collector/lp.js";

const cfg = loadConfig();
const env = loadEnv({ requireWallet: false });
const db = openDb(cfg.db.path);
const c = publicClient("base", env.BASE_RPC_URL);
const pm = ADDRESSES.base.uniswapV4PoolManager!;
const rows = db.prepare(`SELECT t.symbol, t.address, t.creator, t.pool_address, t.discovered_block, p.close_reason, ROUND(p.net_pnl_usd,2) pnl
  FROM positions p JOIN tokens t ON t.id = p.token_id
  WHERE p.arm = 'base_uni_all' AND p.exit_plan = 'live' AND p.closed_at IS NOT NULL AND length(t.pool_address) = 66
  ORDER BY p.closed_at DESC LIMIT 15`).all() as { symbol: string | null; address: string; creator: string | null; pool_address: `0x${string}`; discovered_block: number; close_reason: string; pnl: number }[];
if (!rows.length) { console.log("❌ nincs lezárt base_uni_all pozíció v4 poollal (fusson a bot)"); process.exit(1); }
const head = await c.getBlockNumber();
const counts = new Map<string, number>();
let failures = 0;
for (const r of rows) {
  const getLogs = async (fetch: (f: bigint, t: bigint) => Promise<LiqEvent[]>) => {
    const out: LiqEvent[] = [];
    for (let f = BigInt(r.discovered_block); f <= head; f += 2001n) out.push(...await fetch(f, f + 2000n > head ? head : f + 2000n));
    return out;
  };
  const res = await lpOwner(c, pm, r.pool_address, r.creator ? getAddress(r.creator) as Address : null, getLogs).catch((e) => { failures++; console.log(`   hiba ${r.symbol}: ${(e as Error).message.slice(0, 120)}`); return null; });
  if (!res) continue;
  counts.set(res.kind, (counts.get(res.kind) ?? 0) + 1);
  console.log(`${(r.symbol ?? "?").padEnd(12)} LP most: ${res.kind.padEnd(8)} zárás: ${r.close_reason} (${r.pnl} USD)`);
}
console.log("\nÖsszesen:", [...counts.entries()].map(([k, n]) => `${k}=${n}`).join(", "));
if (failures === rows.length) { console.log("❌ egyik lekérdezés sem sikerült (RPC?)"); process.exitCode = 1; }
else console.log("✅ LP-tulajdonos lekérdezés működik");
