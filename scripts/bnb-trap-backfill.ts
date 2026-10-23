/**
 * BNB gyűrű-tanulás visszamenőleg (2026-10-23): csapda-pumpák felismerése a teljes bnb_pair_trades-ből (src/bnb/ring.ts),
 * majd az árnyékpozíciók ring_n értékének újraszámolása a jelzés pillanatára – csak a jelzés ELŐTT felismert csapdákból
 * (ringBuyers: added_at < jelzés). npm run bnb:trap-backfill
 */
import { loadConfig } from "../src/config.js";
import { openDb } from "../src/db/index.js";
import { learnRingFromTraps, ringBuyers } from "../src/bnb/ring.js";

const cfg = loadConfig();
const db = openDb(cfg.db.path);
const r = learnRingFromTraps(db, 0);
console.log(`csapda-pumpák: ${r.traps}, új gyűrű-jelölt sor: ${r.added}`);
const pos = db.prepare("SELECT id, pair, signal_at, ring_n FROM bnb_shadow_positions").all() as Array<{ id: number; pair: string; signal_at: number; ring_n: number | null }>;
const upd = db.prepare("UPDATE bnb_shadow_positions SET ring_n = ? WHERE id = ?");
const cache = new Map<string, number>(); let changed = 0;
db.transaction(() => { for (const p of pos) { const k = `${p.pair}|${p.signal_at}`; const n = cache.get(k) ?? ringBuyers(db, p.pair, p.signal_at); cache.set(k, n); if (n !== (p.ring_n ?? 0)) { upd.run(n, p.id); changed++; } } })();
console.log(`árnyékpozíciók: ${pos.length}, ring_n változott: ${changed}`);
db.close();
