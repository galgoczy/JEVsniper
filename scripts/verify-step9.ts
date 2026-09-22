/** 9. lépés verify: riport generálása a valódi DB-ből, és néhány szám kereszt-ellenőrzése közvetlen SQL-lel. */
import { loadConfig } from "../src/config.js";
import { openDb } from "../src/db/index.js";
import { buildReport, writeReport, bootstrapCI, median } from "../src/report/index.js";
const cfg = loadConfig();
const db = openDb(cfg.db.path);
const since = Date.now() - 86_400_000;
const { markdown } = buildReport(db, cfg, since);
const ok = (m: string) => console.log("✅", m); const bad = (m: string) => { console.log("❌", m); process.exitCode = 1; };
// kereszt-ellenőrzés
const newN = (db.prepare("SELECT COUNT(*) n FROM tokens WHERE discovered_at > ?").get(since) as { n: number }).n;
const rc = db.prepare("SELECT net_pnl_usd n FROM positions WHERE arm='random_control' AND exit_plan='live' AND window_sec=? AND closed_at > ? AND close_reason != 'invalid_no_tokens'").all(cfg.evaluation.live_window_sec, since) as { n: number }[];
const rcMean = rc.length ? rc.reduce((s, r) => s + r.n, 0) / rc.length : null;
const line = markdown.split("\n").find((l) => l.startsWith("random_control (60 mp"))!;
const shown = /átlag nettó: (\S+) USD, n=(\d+)/.exec(line);
if (shown && Number(shown[2]) === rc.length && (rcMean === null ? shown[1] === "-" : Math.abs(Number(shown[1]) - rcMean) < 0.001)) ok(`random_control átlag egyezik az SQL-lel (${shown[1]}, n=${rc.length})`); else bad(`random_control sor: "${line}" vs SQL ${rcMean} n=${rc.length}`);
const tokLine = markdown.split("\n").find((l) => l.startsWith("- Új tokenek"))!;
const sum = [...tokLine.matchAll(/=(\d+)/g)].reduce((s, m) => s + Number(m[1]), 0);
sum === newN ? ok(`új tokenek összege egyezik (${newN})`) : bad(`új tokenek: riport ${sum} vs SQL ${newN}`);
const ci = bootstrapCI([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]); ci && ci[0] < 5.5 && ci[1] > 5.5 ? ok(`bootstrap CI értelmes: ${ci.map((x) => x.toFixed(2)).join("…")} (átlag 5,5)`) : bad("bootstrap CI");
median([3, 1, 2]) === 2 ? ok("medián ok") : bad("medián");
const r = writeReport(db, cfg);
ok(`riport kiírva: ${r.file}`);
console.log("\n--- Telegram-összefoglaló ---\n" + r.telegram + "\n\n--- Markdown (első 60 sor) ---");
console.log(markdown.split("\n").slice(0, 60).join("\n"));
db.close();
