/** Reaktív-gyár tiltólista feltöltése az élő gyors kihúzásokból + a bnb_sim_checks code_hash / whale_via visszamenőleges kitöltése (2026-10-08). */
import { createPublicClient, http, type PublicClient } from "viem";
import { bsc } from "viem/chains";
import { loadConfig } from "../src/config.js";
import { openDb } from "../src/db/index.js";
import { BNB_RECEIPT_RPC } from "../src/bnb/addresses.js";
import { tokenCodeHash, whaleVia, markReactive, QUICK_RUG_MS } from "../src/bnb/reactive.js";
const db = openDb(loadConfig().db.path); db.pragma("busy_timeout = 30000");
const c = createPublicClient({ chain: bsc, transport: http(BNB_RECEIPT_RPC, { timeout: 20_000, retryCount: 2 }) }) as PublicClient;
const quick = db.prepare("SELECT pair, token, opened_at FROM bnb_live_positions WHERE close_reason LIKE 'drained%' AND closed_at - opened_at < ?").all(QUICK_RUG_MS) as Array<{ pair: string; token: string; opened_at: number }>;
let marks = 0;
for (const q of quick) { const [code, via] = await Promise.all([tokenCodeHash(c, q.token), whaleVia(c, db, q.pair, q.opened_at)]); marks += markReactive(db, q.pair, code, via); }
console.log("élő gyors kihúzás:", quick.length, "→ új tiltó jel:", marks, "| lista:", JSON.stringify(db.prepare("SELECT kind, COUNT(*) n FROM bnb_reactive_marks GROUP BY kind").all()));
const rows = db.prepare("SELECT pair, arm, token, at FROM bnb_sim_checks WHERE code_hash IS NULL").all() as Array<{ pair: string; arm: string; token: string; at: number }>;
const upd = db.prepare("UPDATE bnb_sim_checks SET code_hash = ?, whale_via = ? WHERE pair = ? AND arm = ?");
for (let i = 0; i < rows.length; i += 8) await Promise.all(rows.slice(i, i + 8).map(async (r) => { const [code, via] = await Promise.all([tokenCodeHash(c, r.token), whaleVia(c, db, r.pair, r.at)]); upd.run(code, via, r.pair, r.arm); }));
console.log("szimuláció-sorok kitöltve:", rows.length);
