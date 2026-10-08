/** Egyszerűsített állás: npm run allas [-- --since ÉÉÉÉ-HH-NN] [-- --rovid] [-- --report] (--rovid = a telefonos /allas, --report = a telefonos /report). Csak olvas. */
import { periods, currentSince } from "../src/analysis/periods.js";
import { loadConfig } from "../src/config.js";
import { openDb } from "../src/db/index.js";
import { standings, standingsCompact, reportCompact } from "../src/analysis/standings.js";
const cfg = loadConfig();
const db = openDb(cfg.db.path);
// alapból az aktuális értékelési időszak (config: evaluation.periods); --period N egy adott időszak kezdete; --since egy nap
const i = process.argv.indexOf("--since"), pi = process.argv.indexOf("--period");
const since = i >= 0 ? Date.parse(`${process.argv[i + 1]}T00:00:00Z`) : pi >= 0 ? (periods(cfg)[Number(process.argv[pi + 1]) - 1]?.from ?? NaN) : currentSince(cfg);
if (Number.isNaN(since)) { console.log("❌ hibás dátum (formátum: ÉÉÉÉ-HH-NN)"); process.exit(1); }
console.log(process.argv.includes("--report") ? reportCompact(db, since, cfg) : process.argv.includes("--rovid") ? standingsCompact(db, since, cfg) : standings(db, since, cfg.evaluation.live_window_sec, Date.now(), cfg));
db.close();
