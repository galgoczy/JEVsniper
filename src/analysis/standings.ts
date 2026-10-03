import type { DB } from "../db/index.js";
import { armStats, nextState, type ArmStat } from "./watch.js";
import { DECISION_MIN_N } from "../report/index.js";
import type { Config } from "../config.js";
import { listingSummary } from "../listing/watcher.js";
import { positionValue } from "./explore.js";
import { walletLine, walletNeed, savedWalletBalance } from "./wallet.js";
import { currentPositionUsd } from "../decision/risk.js";

/**
 * Egyszerűsített állás menet közben (Telegram /allas, npm run allas): stratégiánként egy sor.
 * Csak tájékoztató – a lezárt pozíciókból számol, és a „legjobb kombináció” kiválasztása önmagában
 * optimista; a döntés alapja továbbra is a riport döntési táblája.
 */
/**
 * Lezárt + nyitott pozíciók együtt (élő terv), a nyitottak az utolsó ellenőrzéskori áron, eladási költséggel értékelve
 * (mintha most eladnánk). A lassan lezáruló karokat (pl. graduáció) így napok helyett órák alatt látni – becslés.
 */
export function armMtm(db: DB, sinceMs: number, cfg: Config): Map<string, { n: number; mean: number; open: number }> {
  const rows = db.prepare(`SELECT arm, window_sec, opened_at at, closed_at, net_pnl_usd, size_usd, size_native, native_received, tokens_remaining, last_price_native, gas_usd,
      liquidity_at_entry, chain, '' launchpad, '' p
    FROM positions WHERE exit_plan = 'live' AND opened_at > ? AND arm NOT IN ('live','day1_test') AND (close_reason IS NULL OR close_reason NOT LIKE 'invalid%')`).all(sinceMs) as Array<Parameters<typeof positionValue>[0] & { arm: string; window_sec: number }>;
  const acc = new Map<string, { n: number; sum: number; open: number }>();
  for (const r of rows) {
    const v = positionValue(r, cfg.cost_model); if (!v) continue;
    const k = `${r.arm}|${r.window_sec}`;
    const a = acc.get(k) ?? { n: 0, sum: 0, open: 0 }; a.n++; a.sum += v.value; if (v.open) a.open++; acc.set(k, a);
  }
  return new Map([...acc].map(([k, a]) => [k, { n: a.n, mean: a.sum / a.n, open: a.open }]));
}

export function standings(db: DB, sinceMs: number, liveWindow: number, now = Date.now(), cfg?: Config): string {
  const stats = armStats(db, sinceMs);
  const by = new Map<string, ArmStat[]>();
  for (const s of stats) { const arm = s.key.split("|")[0]!; (by.get(arm) ?? by.set(arm, []).get(arm)!).push(s); }
  const f = (x: number) => (x >= 0 ? "+" : "") + x.toFixed(2);
  const mtm = cfg ? armMtm(db, sinceMs, cfg) : null;
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
    const mainW = main ? main.key.split("|")[1] : (arm.startsWith("copy_") || arm.startsWith("grad_") ? "0" : String(liveWindow));
    const m = mtm?.get(`${arm}|${mainW}`);
    const mtmTxt = m && m.open > 0 ? `; nyitottakkal ~${f(m.mean)} (n=${m.n}, nyitott ${m.open})` : "";
    rows.push({ sort: best?.mean ?? main?.mean ?? m?.mean ?? -9, line: `• ${arm}: ${mainTxt}${bestTxt}${mtmTxt}` });
  }
  if (mtm) for (const [k, m] of mtm) { // csak nyitott pozíciókkal rendelkező karok (még nincs lezárt)
    const [arm, w] = k.split("|");
    if (arm === "random_control" || by.has(arm!) || m.open === 0) continue;
    rows.push({ sort: m.mean, line: `• ${arm}${w !== String(liveWindow) && w !== "0" ? ` @${w}s` : ""}: még nincs lezárt; nyitottakkal ~${f(m.mean)} (n=${m.n}, nyitott ${m.open})` });
  }
  rows.sort((a, b) => b.sort - a.sort);
  const hours = Math.round((now - sinceMs) / 3_600_000);
  return [`📋 Állás ${new Date(sinceMs).toISOString().slice(0, 10)} óta (${hours} óra), átlag USD / 1 USD pozíció, lezártak`,
    `Véletlen kontroll (${liveWindow}s, élő terv): ${rc ? `${f(rc.mean)} (n=${rc.n})` : "-"}`,
    ...rows.slice(0, 14).map((r) => r.line), ...(rows.length > 14 ? [`…és még ${rows.length - 14} stratégia`] : []),
    ...(cfg ? [walletLine(db, cfg, sinceMs, currentPositionUsd(db, cfg), now)] : []),
    ...(cfg ? (() => { const l = listingSummary(db, cfg, sinceMs); return l.events ? [`• Listázások: ${l.events} esemény; ${l.plans.map((p) => `${p.name} ${f(p.mean)} (lezárt ${p.closed})`).join(", ")}`] : ["• Listázások: még nem volt új esemény"]; })() : []),
    "⏳ = 90% CI > 0 (n ≥ 20), ✅ = élesítés-jelölt (n ≥ 100). A „legjobb” kombináció optimista; a „nyitottakkal” érték becslés (utolsó ár) – döntéshez: npm run report."].join("\n");
}

/** Rövid kar-nevek a telefonos nézethez. */
const SHORT: Record<string, string> = {
  rule_v2: "v2", rule_v2_strict: "v2_strict", rule_v2_nofactory: "v2_nofact", rule_v2_nojev: "v2_nojev",
  base_uni_hold: "uni_hold", base_uni_hold_nofactory: "hold_nofact", base_uni_all: "base_uni_all", base_uni_clean: "uni_clean",
  copy_smart: "copy", copy_unskilled: "copy_rossz", pons_all: "pons", grad_at: "grad_at", clanker_all: "clanker",
};
/** A telefonos nézet jelölt karjai (a Jev nélküli, eddig nyereséges család) és a viszonyítási alapvonalak. */
const CANDIDATES = ["rule_v2_strict", "rule_v2", "rule_v2_nofactory", "base_uni_hold", "base_uni_hold_nofactory"];
const BASELINES: Array<[string, number | "live"]> = [["base_uni_all", "live"], ["copy_smart", 0], ["pons_all", "live"], ["grad_at", 0]];

/**
 * Telefonos (Telegram /allas) állás, 2026-10-03: rövid sorok (≤ ~30 karakter), elöl az élő kar, a jelöltek Base-eredménye
 * (a nyereség ott keletkezik; a Robinhood-belépések rontják az átlagot), a vesztes alapvonalak egy tömbben, tárca, listázás.
 * A részletes változat: standings() – Telegram /allas_reszletes, npm run allas.
 */
export function standingsCompact(db: DB, sinceMs: number, cfg: Config, now = Date.now()): string {
  const w = cfg.evaluation.live_window_sec;
  const f = (x: number) => (x >= 0 ? "+" : "−") + Math.abs(x).toFixed(2);
  const f1 = (x: number) => (x >= 0 ? "+" : "−") + Math.abs(x).toFixed(1);
  const stats = new Map(armStats(db, sinceMs).map((s) => [s.key, s]));
  const mark = (s: ArmStat | undefined) => { if (!s) return ""; const st = nextState("none", s); return st === "candidate" ? " ✅" : st === "promising" ? " ⏳" : ""; };
  // Base-eredmény karonként (élő ablak, élő terv, lezárt, érvényes)
  const base = new Map((db.prepare(`SELECT arm, COUNT(*) n, AVG(net_pnl_usd) mean, SUM(net_pnl_usd) sum FROM positions
    WHERE chain = 'base' AND window_sec = ? AND exit_plan = 'live' AND opened_at > ? AND closed_at IS NOT NULL AND close_reason NOT LIKE 'invalid%'
      AND arm NOT IN ('live','day1_test') GROUP BY arm`).all(w, sinceMs) as Array<{ arm: string; n: number; mean: number; sum: number }>).map((r) => [r.arm, r]));
  const rc = stats.get(`random_control|${w}|live`);
  const hours = Math.round((now - sinceMs) / 3_600_000);
  const L: string[] = [`📋 Állás · ${hours} óra (${new Date(sinceMs).toISOString().slice(5, 10)} óta)`, `Véletlen: ${rc ? `${f(rc.mean)} (n${rc.n})` : "-"}`, ""];

  const live = cfg.live_entry.arm, liveAll = stats.get(`${live}|${w}|${cfg.live_entry.exit_plan}`), liveBase = base.get(live);
  L.push(`🎯 Élő kar · ${live}`);
  L.push(liveBase ? `Base: ${f(liveBase.mean)} · n${liveBase.n} · Σ${f1(liveBase.sum)}` : "Base: még nincs lezárt");
  if (liveAll) L.push(`Össz: ${f(liveAll.mean)} · n${liveAll.n}${mark(liveAll)}`, `Döntésig: ${liveAll.n}/${DECISION_MIN_N}`);
  L.push("");

  const cands = CANDIDATES.filter((a) => a !== live && base.has(a)).map((a) => base.get(a)!).sort((a, b) => b.sum - a.sum);
  if (cands.length) {
    L.push(`⭐ Jelöltek (${w}s, Base)`);
    for (const c of cands) L.push(`${(SHORT[c.arm] ?? c.arm).padEnd(11)} ${f(c.mean)}·n${c.n}·Σ${f1(c.sum)}`);
    L.push("");
  }

  const losers = BASELINES.map(([a, win]) => {
    const s = stats.get(`${a}|${win === "live" ? w : win}|live`);
    return s ? `${SHORT[a] ?? a} ${Math.abs(s.mean) < 0.05 ? "~0" : f(s.mean)}` : null;
  }).filter((x): x is string => x !== null);
  if (losers.length) {
    L.push("📉 Alapvonalak");
    for (let i = 0; i < losers.length; i += 2) L.push(losers.slice(i, i + 2).join(" · "));
    L.push("");
  }

  const wn = walletNeed(db, cfg, sinceMs, currentPositionUsd(db, cfg), now), bal = savedWalletBalance(db);
  L.push(bal ? `💰 Tárca ${bal.usd.toFixed(1)}$ · igény ${wn.needUsd.toFixed(1)}$ ${bal.usd >= wn.needUsd ? "✅" : "⚠️ KEVÉS"}` : `💰 Igény ${wn.needUsd.toFixed(1)}$ (nincs egyenleg)`);
  const l = listingSummary(db, cfg, sinceMs);
  L.push(`📣 Listázás: ${l.events ? `${l.events} esemény` : "nincs"}`);
  L.push("", "Részletes: /allas_reszletes");
  return L.join("\n");
}
