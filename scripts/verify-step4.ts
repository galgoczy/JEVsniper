/**
 * 4. lépés verify: a DB-ben lévő pillanatképekre lefuttatja a kemény szűrőket, és kiírja a tölcsért okonként.
 * Futtatás: npm run verify:step4
 */
import { loadConfig } from "../src/config.js";
import { openDb } from "../src/db/index.js";
import { hardFilters } from "../src/filters/hard.js";
import type { ParamSnapshot } from "../src/collector/types.js";

const cfg = loadConfig();
const db = openDb(cfg.db.path);
const rows = db.prepare(`SELECT s.params_json, t.chain, t.launchpad, t.symbol, t.address FROM snapshots s JOIN tokens t ON t.id = s.token_id
  WHERE s.window_sec = ? ORDER BY s.id DESC LIMIT 500`).all(cfg.evaluation.live_window_sec) as { params_json: string; chain: string; launchpad: string; symbol: string | null; address: string }[];
if (!rows.length) { console.log("❌ nincs pillanatkép a DB-ben (fusson a bot pár percig)"); process.exit(1); }
const byReason = new Map<string, number>();
const byLp = new Map<string, { n: number; pass: number }>();
let pass = 0;
const examples: string[] = [];
for (const r of rows) {
  const res = hardFilters(JSON.parse(r.params_json) as ParamSnapshot, cfg.hard_filters);
  const lp = byLp.get(`${r.chain}/${r.launchpad}`) ?? { n: 0, pass: 0 }; lp.n++; if (res.pass) lp.pass++; byLp.set(`${r.chain}/${r.launchpad}`, lp);
  if (res.pass) { pass++; if (examples.length < 3) examples.push(`  átment: ${r.chain}/${r.launchpad} ${r.symbol ?? "?"} ${r.address}`); }
  for (const reason of res.reasons) { const k = reason.split(":")[0]!.replace(/_[\d.]+(pct|usd)$/, ""); byReason.set(k, (byReason.get(k) ?? 0) + 1); }
}
console.log(`Pillanatképek (${cfg.evaluation.live_window_sec} mp-es ablak): ${rows.length}`);
console.log(`✅ átment: ${pass}  |  kiesett: ${rows.length - pass}`);
for (const [k, n] of [...byReason.entries()].sort((a, b) => b[1] - a[1])) console.log(`   ${k}: ${n}`);
console.log("Launchpadonként (átment / összes):");
for (const [k, v] of byLp) console.log(`   ${k}: ${v.pass} / ${v.n}`);
console.log("ℹ️ A régi pillanatképek a javítás előtti airdrop-számítással készültek; a friss adatot a bot újraindítása után gyűjti.");
console.log(examples.join("\n"));
db.close();
