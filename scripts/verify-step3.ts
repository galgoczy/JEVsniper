/**
 * 3. lépés verify: egy tokenre lefut a paramétergyűjtő, kiírja az összes mezőt, és megszámolja az "unknown"-okat.
 * Futtatás: npm run verify:step3               → a DB legutóbbi tokenje
 *           npm run verify:step3 -- <lánc> <cím> → adott token (pl. robinhood 0x...)
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
  : db.prepare("SELECT * FROM tokens ORDER BY id DESC LIMIT 1").get()) as TokenRow | undefined;
if (!row) { console.log("❌ nincs ilyen token a DB-ben (előbb fusson a bot, vagy adj meg láncot és címet)"); process.exit(1); }
console.log(`Token: ${row.chain}/${row.launchpad} ${row.symbol ?? "?"} ${row.address} (felfedezve ${new Date(row.discovered_at).toISOString()})`);
const collector = new Collector(db, clients, new EthPrice(clients.base));
const t0 = Date.now();
const snap = await collector.collect(row, cfg.evaluation.live_window_sec);
console.log(JSON.stringify(snap, null, 1));
const u = countUnknown(snap);
console.log(`\n✅ ${u.total - u.unknown}/${u.total} mező kitöltve, ${u.unknown} unknown (${Date.now() - t0} ms): ${u.unknownKeys.join(", ")}`);
collector.saveSnapshot(row, snap, cfg.db.max_snapshot_bytes);
const saved = db.prepare("SELECT length(params_json) len FROM snapshots WHERE token_id = ? AND window_sec = ?").get(row.id, cfg.evaluation.live_window_sec) as { len: number };
console.log(`✅ pillanatkép mentve a DB-be (${saved.len} bájt, limit ${cfg.db.max_snapshot_bytes})`);
db.close();
