/** Egyszerűsített állás: npm run allas [-- --since ÉÉÉÉ-HH-NN] [-- --rovid] (--rovid = a telefonos /allas nézet). Csak olvas. */
import { loadConfig } from "../src/config.js";
import { openDb } from "../src/db/index.js";
import { standings, standingsCompact } from "../src/analysis/standings.js";
const cfg = loadConfig();
const db = openDb(cfg.db.path);
const i = process.argv.indexOf("--since");
const since = Date.parse(`${i >= 0 ? process.argv[i + 1] : cfg.alerts.since}T00:00:00Z`);
if (Number.isNaN(since)) { console.log("❌ hibás dátum (formátum: ÉÉÉÉ-HH-NN)"); process.exit(1); }
console.log(process.argv.includes("--rovid") ? standingsCompact(db, since, cfg) : standings(db, since, cfg.evaluation.live_window_sec, Date.now(), cfg));
db.close();
