/**
 * Szabálykereső: npm run explore [-- --since 2026-09-27] [-- --window 60|1800] [-- --plan live|B|C|...] [-- --min-age-h 6]
 * Csak olvas az adatbázisból; az eredményt kiírja és a reports/ mappába menti.
 */
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../src/config.js";
import { openDb } from "../src/db/index.js";
import { explore, loadSamples, CONDITIONS } from "../src/analysis/explore.js";

const cfg = loadConfig();
const db = openDb(cfg.db.path);
const arg = (name: string) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; };
const sinceStr = arg("--since") ?? cfg.alerts.since;
const since = Date.parse(`${sinceStr}T00:00:00Z`);
if (Number.isNaN(since)) { console.log(`❌ hibás dátum: ${sinceStr} (formátum: ÉÉÉÉ-HH-NN)`); process.exit(1); }
const windowSec = Number(arg("--window") ?? cfg.evaluation.live_window_sec);
const plan = arg("--plan") ?? "live";
const minAgeH = Number(arg("--min-age-h") ?? 6);

const { samples, young, unvalued } = loadSamples(db, cfg.cost_model, { windowSec, plan, sinceMs: since, minAgeMs: minAgeH * 3_600_000 });
const pc = (x: number) => `${(x * 100).toFixed(0)}%`;
const f3 = (x: number) => (Number.isFinite(x) ? x.toFixed(3) : "-");
const openN = samples.filter((s) => s.open).length;
const L: string[] = [`# Szabálykereső – ${new Date().toISOString().slice(0, 16)} UTC`,
  `Adat: ${sinceStr} óta, ${windowSec} mp-es ablak, „${plan}” kilépési terv; ${samples.length} token (ebből ${openN} még nyitott, az utolsó áron értékelve).`,
  `Kihagyva: ${young} token, amely ${minAgeH} óránál frissebb; ${unvalued} értékelhetetlen (nincs ár).`,
  "Érték = árnyékpozíció eredménye 1 USD-re, költségekkel és a pool likviditásával számolt csúszással.",
  "Tanító rész: az időrend első 2/3-a; ellenőrző rész: az utolsó 1/3 (a keresés nem látta).", ""];

if (samples.length < 90) {
  L.push(`❌ Még kevés az adat (legalább 90 token kell, most ${samples.length}). Futtasd újra 1–2 nap múlva.`);
} else {
  const r = explore(samples);
  L.push(`Kipróbált szabályok: ${r.tried} (${CONDITIONS.length} feltétel, 1–2 feltétel hatókörönként). Ellenőrző rész kezdete: ${r.splitAt ? new Date(r.splitAt).toISOString().slice(0, 16) : "-"} UTC`, "",
    "## Alapvonalak (minden token az adott hatókörben)", "| hatókör | tanító n | nyerő | átlag érték | ellenőrző n | nyerő | átlag érték |", "|---|---|---|---|---|---|---|",
    ...r.scopes.map((s) => `| ${s.scope} | ${s.train.n} | ${pc(s.train.win)} | ${f3(s.train.mean)} | ${s.test.n} | ${pc(s.test.win)} | ${f3(s.test.mean)} |`), "",
    "## Legjobb szabályok (tanító rész alapján, az átlag óvatos alsó becslése szerint), ellenőrzés a későbbi adaton",
    "✔ = az ellenőrző részen is egyértelműen jobb az alapvonalnál: az átlag óvatos (90%) alsó becslése is fölötte van (legalább 15 token).", "",
    "| | hatókör | feltételek | tanító n | nyerő | átlag | ellenőrző n | nyerő | átlag | alsó becslés | alapvonal |", "|---|---|---|---|---|---|---|---|---|---|---|",
    ...r.results.map((x) => `| ${x.holds ? "✔" : ""} | ${x.scope} | ${x.conds.join(" ÉS ")} | ${x.train.n} | ${pc(x.train.win)} | ${f3(x.train.mean)} | ${x.test.n} | ${x.test.n ? pc(x.test.win) : "-"} | ${x.test.n ? f3(x.test.mean) : "-"} | ${f3(x.test.low)} | ${f3(x.baseTest.mean)} |`), "",
    "Figyelem: sok szabályt próbáltunk, ezért egy-egy ✔ szerencséből is kijöhet. Egy ✔ szabály csak jelölt:",
    "új árnyékstratégiaként kell friss adaton igazolnia magát, mielőtt élesítés szóba jöhet.");
}
const out = L.join("\n");
console.log(out);
fs.mkdirSync(cfg.report.output_dir, { recursive: true });
const file = path.join(cfg.report.output_dir, `szabalykereso_${new Date().toISOString().slice(0, 10)}_${windowSec}s_${plan}.md`);
fs.writeFileSync(file, out);
console.log(`\n✅ mentve: ${file}`);
db.close();
