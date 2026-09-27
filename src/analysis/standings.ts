import type { DB } from "../db/index.js";
import { armStats, nextState, type ArmStat } from "./watch.js";

/**
 * Egyszerűsített állás menet közben (Telegram /allas, npm run allas): stratégiánként egy sor.
 * Csak tájékoztató – a lezárt pozíciókból számol, és a „legjobb kombináció” kiválasztása önmagában
 * optimista; a döntés alapja továbbra is a riport döntési táblája.
 */
export function standings(db: DB, sinceMs: number, liveWindow: number, now = Date.now()): string {
  const stats = armStats(db, sinceMs);
  const by = new Map<string, ArmStat[]>();
  for (const s of stats) { const arm = s.key.split("|")[0]!; (by.get(arm) ?? by.set(arm, []).get(arm)!).push(s); }
  const open = new Map((db.prepare("SELECT arm, COUNT(*) n FROM positions WHERE closed_at IS NULL AND exit_plan = 'live' AND opened_at > ? GROUP BY arm").all(sinceMs) as Array<{ arm: string; n: number }>).map((r) => [r.arm, r.n]));
  const f = (x: number) => (x >= 0 ? "+" : "") + x.toFixed(2);
  const mark = (s: ArmStat) => { const st = nextState("none", s); return st === "candidate" ? " ✅" : st === "promising" ? " ⏳" : ""; };
  const rc = stats.find((s) => s.key === `random_control|${liveWindow}|live`);
  const rows: Array<{ sort: number; line: string }> = [];
  for (const [arm, ss] of by) {
    if (arm === "random_control") continue;
    const main = ss.find((s) => s.key === `${arm}|${liveWindow}|live`) ?? ss.filter((s) => s.key.endsWith("|live")).sort((a, b) => b.n - a.n)[0];
    const best = ss.filter((s) => s.n >= 10).sort((a, b) => b.mean - a.mean)[0];
    const [, bw, bp] = best ? best.key.split("|") : [];
    const mainTxt = main ? `${f(main.mean)} (n=${main.n})${mark(main)}` : "-";
    const bestTxt = best && best !== main ? `; legjobb ${bw}s/${bp}: ${f(best.mean)} (n=${best.n})${mark(best)}` : "";
    rows.push({ sort: best?.mean ?? main?.mean ?? -9, line: `• ${arm}: ${mainTxt}${bestTxt}${open.get(arm) ? `; nyitott ${open.get(arm)}` : ""}` });
  }
  rows.sort((a, b) => b.sort - a.sort);
  const hours = Math.round((now - sinceMs) / 3_600_000);
  return [`📋 Állás ${new Date(sinceMs).toISOString().slice(0, 10)} óta (${hours} óra), átlag USD / 1 USD pozíció, lezártak`,
    `Véletlen kontroll (${liveWindow}s, élő terv): ${rc ? `${f(rc.mean)} (n=${rc.n})` : "-"}`,
    ...rows.slice(0, 14).map((r) => r.line), ...(rows.length > 14 ? [`…és még ${rows.length - 14} stratégia`] : []),
    "⏳ = 90% CI > 0 (n ≥ 20), ✅ = élesítés-jelölt (n ≥ 100). A „legjobb” kombináció optimista – döntéshez: npm run report."].join("\n");
}
