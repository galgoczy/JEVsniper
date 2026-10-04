/**
 * Egyszeri helyreállítás (2026-10-04): az ár-józansági szűrő miatt beragadt, valóban összeomlott Base v4-tokenek pozíciói.
 * A pool utolsó Swap-ját (sqrtPriceX96) a láncról visszakeresi; ha az ár a belépési ár egymilliomoda alatt van, a pozícióhoz
 * elmenti az összeomlott árat (low_price_native) és egy 5 percnél régebbi észlelési időt – a monitor a következő ellenőrzéskor
 * a vészfékkel lezárja. Csak a megadott pozíciókat érinti: npx tsx scripts/recover-crashed.ts <id,id,...> [--hours 30]
 */
import "dotenv/config";
import { getAddress } from "viem";
import { loadConfig } from "../src/config.js";
import { loadEnv } from "../src/env.js";
import { openDb } from "../src/db/index.js";
import { publicClient } from "../src/chains/index.js";
import { ADDRESSES } from "../src/chains/addresses.js";
import { uniswapV4SwapAbi } from "../src/abis/pools.js";
import { priceFromSqrtX96 } from "../src/collector/stats.js";

const ids = (process.argv[2] ?? "").split(",").map(Number).filter((x) => x > 0);
const h = process.argv.indexOf("--hours"); const hours = Number(h >= 0 ? process.argv[h + 1] : 30);
if (!ids.length) { console.log("használat: npx tsx scripts/recover-crashed.ts <id,id,...>"); process.exit(1); }
const cfg = loadConfig(), env = loadEnv({ requireWallet: false }), db = openDb(cfg.db.path);
const c = publicClient("base", env.BASE_RPC_URL);
const rows = db.prepare(`SELECT p.id, p.entry_price_native e, t.id tid, t.symbol, t.address, t.pool_address pool, t.pair_token, t.decimals FROM positions p JOIN tokens t ON t.id = p.token_id
  WHERE p.id IN (${ids.map(() => "?").join(",")}) AND p.closed_at IS NULL AND p.chain = 'base' AND t.pool_address IS NOT NULL AND length(t.pool_address) = 66`).all(...ids) as Array<{ id: number; e: number; tid: number; symbol: string; address: string; pool: `0x${string}`; pair_token: string | null; decimals: number | null }>;
const pools = [...new Set(rows.map((r) => r.pool.toLowerCase()))] as `0x${string}`[];
const head = await c.getBlockNumber(); const from = head - BigInt(Math.round(hours * 3600 / 2));
const last = new Map<string, { sqrt: bigint; block: bigint }>();
for (let f = from; f <= head; f += 2000n) {
  const logs = await c.getLogs({ address: ADDRESSES.base.uniswapV4PoolManager!, event: uniswapV4SwapAbi[0], args: { id: pools }, fromBlock: f, toBlock: f + 1999n > head ? head : f + 1999n });
  for (const l of logs) last.set((l.args.id as string).toLowerCase(), { sqrt: l.args.sqrtPriceX96!, block: l.blockNumber! });
}
const upd = db.prepare("UPDATE positions SET low_price_native = ?, low_price_since = ? WHERE id = ? AND closed_at IS NULL");
let n = 0; const seen = new Map<string, string>();
for (const r of rows) {
  const s = last.get(r.pool.toLowerCase()); if (!s) { seen.set(r.symbol, "nincs swap az ablakban"); continue; }
  const tokenIsC0 = BigInt(getAddress(r.address)) < BigInt(r.pair_token ?? "0x0000000000000000000000000000000000000000");
  const price = priceFromSqrtX96(s.sqrt, tokenIsC0, r.decimals ?? 18); const x = price / r.e;
  seen.set(r.symbol, `utolsó ár ${x.toExponential(2)}x (blokk ${s.block})`);
  if (x > 0 && x < 1e-6) { n += upd.run(price, Date.now() - 6 * 60_000, r.id).changes; }
}
for (const [k, v] of seen) console.log(`${k}: ${v}`);
console.log(`✅ ${n} pozíció megjelölve összeomlottként (a monitor a következő ellenőrzéskor zárja)`);
db.close();
