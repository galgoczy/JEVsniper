/** Gyűrű-lista feltöltése az eddigi eladhatatlan élő pozíciók párjaiból, és a ring_n visszamenőleges kitöltése (2026-10-08). */
import { loadConfig } from "../src/config.js";
import { openDb } from "../src/db/index.js";
import { learnRingFromPair, ringBuyers, ringSize } from "../src/bnb/ring.js";
const db = openDb(loadConfig().db.path); db.pragma("busy_timeout = 30000");
const OWN = "0x0eCFB2e91fa39aFB1702E578bac13FA6083B8e1b";
const bad = db.prepare("SELECT DISTINCT pair FROM bnb_live_positions WHERE close_reason LIKE 'unsellable%' OR phase = 'unsellable'").all() as Array<{ pair: string }>;
for (const b of bad) console.log("rossz pár", b.pair, "új jelölt", learnRingFromPair(db, b.pair, OWN));
console.log("gyűrű-tagok (≥2 rossz párban):", ringSize(db));
const rows = db.prepare("SELECT id, pair, opened_at FROM bnb_shadow_positions WHERE ring_n IS NULL").all() as Array<{ id: number; pair: string; opened_at: number }>;
const upd = db.prepare("UPDATE bnb_shadow_positions SET ring_n = ? WHERE id = ?");
const cache = new Map<string, number>();
db.transaction(() => { for (const r of rows) { const k = `${r.pair}|${r.opened_at}`; let n = cache.get(k); if (n === undefined) { n = ringBuyers(db, r.pair, r.opened_at); cache.set(k, n); } upd.run(n, r.id); } })();
console.log("kitöltve:", rows.length, "pozíció");
