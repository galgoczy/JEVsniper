/**
 * 3. lépés verify: egy tokenre lefut a paramétergyűjtő, kiírja az összes mezőt, és megszámolja az "unknown"-okat.
 * Futtatás: npm run verify:step3               → a DB legutóbbi tokenje
 *           npm run verify:step3 -- <lánc> <cím> → adott token (pl. robinhood 0x...)
 *           npm run verify:step3 -- pons|clanker|uniswap → az adott launchpad legutóbbi tokenje, amin már volt swap
 */
import { loadConfig } from "../src/config.js";
import { loadEnv } from "../src/env.js";
import { openDb } from "../src/db/index.js";
import { publicClient } from "../src/chains/index.js";
import { Collector, EthPrice, countUnknown, type TokenRow } from "../src/collector/index.js";

const cfg = loadConfig();
const env = loadEnv({ requireWallet: false });
const db = openDb(cfg.db.path);
const clients = { base: publicClient("base", env.BASE_RPC_URL), robinhood: publicClient("robinhood", env.ROBINHOOD_RPC_URL) };
const [chainArg, addrArg] = process.argv.slice(2);
const row = (chainArg && addrArg
  ? db.prepare("SELECT * FROM tokens WHERE chain = ? AND lower(address) = lower(?)").get(chainArg, addrArg)
  : chainArg
    ? db.prepare("SELECT * FROM tokens WHERE launchpad = ? AND discovered_at BETWEEN ? AND ? ORDER BY id DESC LIMIT 1").get(chainArg, Date.now() - 30 * 60_000, Date.now() - 180_000)
    : db.prepare("SELECT * FROM tokens ORDER BY id DESC LIMIT 1").get()) as TokenRow | undefined;
if (!row) { console.log("❌ nincs ilyen token a DB-ben (előbb fusson a bot, vagy adj meg láncot és címet)"); process.exit(1); }
console.log(`Token: ${row.chain}/${row.launchpad} ${row.symbol ?? "?"} ${row.address} (felfedezve ${new Date(row.discovered_at).toISOString()})`);
const collector = new Collector(db, clients, new EthPrice(clients.base));
const t0 = Date.now();
let snap;
try { snap = await collector.collect(row, cfg.evaluation.live_window_sec); }
catch (e) { console.log(`❌ RPC-hiba a gyűjtés elején: ${(e as Error).message.split("\n").slice(0, 4).join(" | ")}`); process.exit(1); }
console.log(JSON.stringify(snap, null, 1));
const u = countUnknown(snap);
console.log(`\n✅ ${u.total - u.unknown}/${u.total} mező kitöltve, ${u.unknown} unknown (${Date.now() - t0} ms): ${u.unknownKeys.join(", ")}`);
for (const e of [...new Set(collector.errors)]) console.log(`ℹ️ RPC-hiba – ${e}`);
if (snap.meta_snapshot.eth_usd === "unknown") console.log("ℹ️ ETH/USD (Chainlink, Base RPC) nem jött meg");
collector.saveSnapshot(row, snap, cfg.db.max_snapshot_bytes);
const saved = db.prepare("SELECT length(params_json) len FROM snapshots WHERE token_id = ? AND window_sec = ?").get(row.id, cfg.evaluation.live_window_sec) as { len: number };
console.log(`✅ pillanatkép mentve a DB-be (${saved.len} bájt, limit ${cfg.db.max_snapshot_bytes})`);
db.close();
