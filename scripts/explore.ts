/**
 * Szabálykereső: npm run explore [-- --since 2026-09-27] [-- --window 60|1800]
 * Csak olvas az adatbázisból; az eredményt kiírja és a reports/ mappába menti.
 */
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../src/config.js";
import { openDb } from "../src/db/index.js";
import { explore, loadSamples, PAYOFF, CONDITIONS } from "../src/analysis/explore.js";

const cfg = loadConfig();
const db = openDb(cfg.db.path);
const arg = (name: string) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; };
const sinceStr = arg("--since") ?? cfg.alerts.since;
const since = Date.parse(`${sinceStr}T00:00:00Z`);
if (Number.isNaN(since)) { console.log(`❌ hibás dátum: ${sinceStr} (formátum: ÉÉÉÉ-HH-NN)`); process.exit(1); }
const windowSec = Number(arg("--window") ?? cfg.evaluation.live_window_sec);

const { samples, pending } = loadSamples(db, windowSec, since);
const pc = (x: number) => `${(x * 100).toFixed(0)}%`;
const L: string[] = [`# Szabálykereső – ${new Date().toISOString().slice(0, 16)} UTC`,
  `Adat: ${sinceStr} óta, ${windowSec} mp-es ablak; ${samples.length} lezárt token (${pending} még nyitott, kihagyva).`,
  `Közelítő érték 1 USD-re: 2x előbb = +${PAYOFF.win}, −40% előbb = ${PAYOFF.loss}, egyik sem = ${PAYOFF.neither}, mínusz oda-vissza költség.`,
  "Tanító rész: az időrend első 2/3-a; ellenőrző rész: az utolsó 1/3 (a keresés nem látta).", ""];

if (samples.length < 90) {
  L.push(`❌ Még kevés az adat (legalább 90 lezárt token kell, most ${samples.length}). Futtasd újra 1–2 nap múlva.`);
} else {
  const r = explore(samples, cfg.cost_model);
  L.push(`Kipróbált szabályok: ${r.tried} (${CONDITIONS.length} feltétel, 1–2 feltétel hatókörönként). Ellenőrző rész kezdete: ${r.splitAt ? new Date(r.splitAt).toISOString().slice(0, 16) : "-"} UTC`, "",
    "## Alapvonalak (minden token az adott hatókörben)", "| hatókör | tanító n | 2x előbb | érték | ellenőrző n | 2x előbb | érték |", "|---|---|---|---|---|---|---|",
    ...r.scopes.map((s) => `| ${s.scope} | ${s.train.n} | ${pc(s.train.win)} | ${s.train.ev.toFixed(3)} | ${s.test.n} | ${pc(s.test.win)} | ${s.test.ev.toFixed(3)} |`), "",
    "## Legjobb szabályok (tanító rész alapján), ellenőrzés a későbbi adaton",
    "✔ = az ellenőrző részen is egyértelműen jobb az alapvonalnál: a 2x-arány óvatos alsó becslése is fölötte van, és az értéke is jobb (legalább 15 token).", "",
    "| | hatókör | feltételek | tanító n | 2x | −40% | érték | ellenőrző n | 2x | −40% | érték | alapvonal értéke |", "|---|---|---|---|---|---|---|---|---|---|---|---|",
    ...r.results.map((x) => `| ${x.holds ? "✔" : ""} | ${x.scope} | ${x.conds.join(" ÉS ")} | ${x.train.n} | ${pc(x.train.win)} | ${pc(x.train.loss)} | ${x.train.ev.toFixed(3)} | ${x.test.n} | ${x.test.n ? pc(x.test.win) : "-"} | ${x.test.n ? pc(x.test.loss) : "-"} | ${x.test.n ? x.test.ev.toFixed(3) : "-"} | ${x.baseTest.ev.toFixed(3)} |`), "",
    "Figyelem: sok szabályt próbáltunk, ezért néhány ✔ szerencséből is kijöhet. Egy ✔ szabály csak jelölt:",
    "új árnyékstratégiaként kell friss adaton igazolnia magát, mielőtt élesítés szóba jöhet.");
}
const out = L.join("\n");
console.log(out);
fs.mkdirSync(cfg.report.output_dir, { recursive: true });
const file = path.join(cfg.report.output_dir, `szabalykereso_${new Date().toISOString().slice(0, 10)}_${windowSec}s.md`);
fs.writeFileSync(file, out);
console.log(`\n✅ mentve: ${file}`);
db.close();
