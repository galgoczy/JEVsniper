import type { DB } from "../db/index.js";
import { armStats, nextState, type ArmStat } from "./watch.js";
import { DECISION_MIN_N } from "../report/index.js";
import type { Config } from "../config.js";
import { listingSummary } from "../listing/watcher.js";
import { positionValue } from "./explore.js";
import { walletLine, walletNeed, savedWalletBalance } from "./wallet.js";
import { currentPositionUsd } from "../decision/risk.js";
import { applyClose, computePositionUsd, type CompoundState } from "../compound/index.js";

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
const SHORT: Record<string, string> = { pons_flip95: "flip95",
  rule_v2: "v2", rule_v2_strict: "v2_strict", rule_v2_nofactory: "v2_nofact", rule_v2_nojev: "v2_nojev",
  base_uni_hold: "uni_hold", base_uni_hold_nofactory: "hold_nofact", base_uni_all: "base_uni_all", base_uni_clean: "uni_clean",
  copy_smart: "copy", copy_unskilled: "copy_rossz", pons_all: "pons", grad_at: "grad_at", clanker_all: "clanker",
  pons_pregrad_50: "pregrad_50", pons_pregrad_80: "pregrad_80", grad_15_all: "grad_15", grad_30s: "grad_30s", random_control: "véletlen",
};
/** Robinhood-blokk (2026-10-03): a Base-jelölt élő kar RH-eredménye („ha éled a tömeg”), a graduációs és a graduáció előtti karok. */
const RH_ARMS: Array<[string, number | "live"]> = [["rule_v2_strict", "live"], ["pons_pregrad_50", 0], ["pons_pregrad_80", 0], ["grad_at", 0], ["grad_30s", 0], ["grad_15_all", 0], ["pons_flip95", 0]];
/** A telefonos nézet jelölt karjai (a Jev nélküli, eddig nyereséges család) és a viszonyítási alapvonalak. */
const CANDIDATES = ["rule_v2_strict", "rule_v2", "rule_v2_nofactory", "base_uni_hold", "base_uni_hold_nofactory"];
const BASELINES: Array<[string, number | "live"]> = [["base_uni_all", "live"], ["copy_smart", 0], ["pons_all", "live"]];

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

  // Robinhood: lánconkénti eredmény (lezárt) + nyitott darabszám
  const rh = new Map((db.prepare(`SELECT arm || '|' || window_sec k, SUM(closed_at IS NOT NULL) n, AVG(CASE WHEN closed_at IS NOT NULL THEN net_pnl_usd END) mean,
      SUM(CASE WHEN closed_at IS NOT NULL THEN net_pnl_usd ELSE 0 END) sum, SUM(closed_at IS NULL) open FROM positions
    WHERE chain = 'robinhood' AND (exit_plan = 'live' AND arm NOT IN ('pons_flip95') OR exit_plan = 'flip' AND arm = 'pons_flip95') AND opened_at > ? AND (close_reason IS NULL OR close_reason NOT LIKE 'invalid%') GROUP BY 1`)
    .all(sinceMs) as Array<{ k: string; n: number; mean: number | null; sum: number; open: number }>).map((r) => [r.k, r]));
  const rhLines = RH_ARMS.map(([a, win]) => {
    const r = rh.get(`${a}|${win === "live" ? w : win}`); const name = (SHORT[a] ?? a).padEnd(11);
    if (!r) return `${name} még nincs`;
    return r.n ? `${name} ${f(r.mean ?? 0)}·n${r.n}·Σ${f1(r.sum)}` : `${name} nyitott ${r.open}`;
  });
  L.push("🟣 Robinhood", ...rhLines, "");

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
  L.push("", "Riport: /report", "Részletes: /allas_reszletes");
  return L.join("\n");
}

/** Kiesett mérési időszakok (a kilépés-figyelő leállása, 2026-10-01/02) – az időarányos számításból levonva. */
const OUTAGES: Array<[number, number]> = [[Date.parse("2026-10-01T21:27:44Z"), Date.parse("2026-10-02T06:09:50Z")]];

/** Aktív napok: az első érvényes belépéstől most-ig, a kiesett időszakok átfedését levonva. */
export function activeDays(firstMs: number, now: number): number {
  let ms = now - firstMs;
  for (const [a, b] of OUTAGES) ms -= Math.max(0, Math.min(b, now) - Math.max(a, firstMs));
  return Math.max(ms, 0) / 86_400_000;
}

/** Időarányos sorok (USD/nap · belépés/nap) a lezárt pozíciókból (1 USD-s mérés), az első érvényes belépéstől számolt aktív idővel. */
export function tempoLines(db: DB, sinceMs: number, cfg: Config, now = Date.now()): { base: string[]; rh: string[] } {
  const w = cfg.evaluation.live_window_sec;
  const rows = db.prepare(`SELECT chain, arm, window_sec w, COUNT(*) n, SUM(net_pnl_usd) sum, MIN(opened_at) first FROM positions
    WHERE exit_plan = 'live' AND opened_at > ? AND closed_at IS NOT NULL AND close_reason NOT LIKE 'invalid%' AND arm NOT IN ('live','day1_test')
    GROUP BY chain, arm, window_sec`).all(sinceMs) as Array<{ chain: string; arm: string; w: number; n: number; sum: number; first: number }>;
  const by = new Map(rows.map((r) => [`${r.chain}|${r.arm}|${r.w}`, r]));
  const s = (x: number) => (x >= 0 ? "+" : "−") + Math.abs(x).toFixed(1);
  const perDay = (chain: string, arm: string, win: number) => { const r = by.get(`${chain}|${arm}|${win}`); return r ? r.sum / Math.max(activeDays(r.first, now), 1e-9) : -Infinity; };
  const line = (chain: string, arm: string, win: number) => {
    const r = by.get(`${chain}|${arm}|${win}`); if (!r) return null;
    const name = `${SHORT[arm] ?? arm}${arm === cfg.live_entry.arm && chain === "base" ? "★" : ""}`.padEnd(12);
    const d = activeDays(r.first, now); if (d < 0.25) return `${name}kevés idő (n${r.n})`;
    return `${name}${s(r.sum / d).padStart(7)} ·${(r.n / d).toFixed(0).padStart(3)}p`;
  };
  const base = [...[...CANDIDATES].sort((a, b) => perDay("base", b, w) - perDay("base", a, w)).map((a) => line("base", a, w)),
    line("base", "random_control", w), line("base", "base_uni_all", w)].filter((x): x is string => x !== null);
  const rh = RH_ARMS.map(([a, win]) => line("robinhood", a, win === "live" ? w : win)).filter((x): x is string => x !== null);
  return { base, rh };
}

/**
 * Visszaforgatás-szimuláció (a compound-szabály napi felülvizsgálattal): ha az élő kar (Base, élő ablak, élő terv) az eddigi
 * árnyékeredményeivel élesben, a mostani alapmérettel futott volna, mekkora lenne ma a belépő. Napi újraszámolás a
 * compound.recalc_time_utc időpontjában (UTC-nap határán), ugyanazokkal a függvényekkel, mint az élő compound.
 */
export function compoundSim(db: DB, sinceMs: number, cfg: Config, now = Date.now()): { size: number; pool: number; reserve: number; closes: number } {
  const rows = db.prepare(`SELECT opened_at o, closed_at c, net_pnl_usd v, size_usd s FROM positions WHERE arm = ? AND chain = 'base' AND window_sec = ? AND exit_plan = ?
    AND opened_at > ? AND closed_at IS NOT NULL AND close_reason NOT LIKE 'invalid%' ORDER BY closed_at`)
    .all(cfg.live_entry.arm, cfg.evaluation.live_window_sec, cfg.live_entry.exit_plan, sinceMs) as Array<{ o: number; c: number; v: number; s: number }>;
  const [hh, mm] = cfg.compound.recalc_time_utc.split(":").map(Number) as [number, number];
  const recalcAt = (t: number) => { const d = new Date(t); d.setUTCHours(hh, mm, 0, 0); return d.getTime() <= t ? d.getTime() : d.getTime() - 86_400_000; };
  let st: CompoundState = { deposit_usd: cfg.risk.deposit_cap_usd, growth_pool_usd: 0, reserve_usd: 0, working_capital_peak_usd: cfg.risk.deposit_cap_usd, position_usd: cfg.risk.base_position_usd, updated_at: 0 };
  const sizeAt = new Map<number, number>(); // napi újraszámolás időpontja → méret
  let lastRecalc = rows.length ? recalcAt(rows[0]!.o) : recalcAt(now);
  const advance = (t: number) => { // napi felülvizsgálatok t-ig
    while (lastRecalc + 86_400_000 <= t) { lastRecalc += 86_400_000; st = { ...st, position_usd: computePositionUsd(st, cfg.risk, cfg.compound, true) }; sizeAt.set(lastRecalc, st.position_usd); }
  };
  const sizeFor = (t: number) => { let size = cfg.risk.base_position_usd; for (const [at, sz] of sizeAt) if (at <= t) size = sz; return size; };
  for (const r of rows) { advance(r.c); const scale = sizeFor(r.o) / (r.s || 1); st = applyClose(st, r.v * scale, cfg.compound.profit_share_to_growth_pool); }
  advance(now);
  return { size: st.position_usd, pool: st.growth_pool_usd, reserve: st.reserve_usd, closes: rows.length };
}

/**
 * Telegram /report (2026-10-03): időarányos összehasonlítás (USD/nap · belépés/nap) + az /allas adatai + visszaforgatás.
 * Rövid sorok telefonra. A teljes markdown riport fájlba íródik (writeReport), a hivatkozást a hívó fűzi hozzá.
 */
export function reportCompact(db: DB, sinceMs: number, cfg: Config, now = Date.now()): string {
  const all = standingsCompact(db, sinceMs, cfg, now).split("\n");
  const body = all.slice(1).filter((l) => !l.startsWith("Részletes:") && !l.startsWith("Riport:"));
  const t = tempoLines(db, sinceMs, cfg, now);
  const hours = Math.round((now - sinceMs) / 3_600_000);
  const at = body.findIndex((l) => l.startsWith("⭐") || l.startsWith("🟣"));
  const tempo = ["⏱ USD/nap · belépés/nap", `🔵 Base (${cfg.evaluation.live_window_sec}s)`, ...t.base, "🟣 Robinhood", ...(t.rh.length ? t.rh : ["még nincs lezárt"]), ""];
  const merged = at >= 0 ? [...body.slice(0, at), ...tempo, ...body.slice(at)] : [...body, ...tempo];
  const sim = compoundSim(db, sinceMs, cfg, now), cs = db.prepare("SELECT position_usd, growth_pool_usd FROM compound_state WHERE id = 1").get() as { position_usd: number; growth_pool_usd: number } | undefined;
  const [hh, mm] = cfg.compound.recalc_time_utc.split(":");
  const comp = [`🔁 Visszaforgatás 30% · napi`, `felülvizsgálat ${hh}:${mm} UTC`, `Belépő most: ${currentPositionUsd(db, cfg).toFixed(2)}$ · kassza ${(cs?.growth_pool_usd ?? 0).toFixed(2)}$`,
    `Élesben ma: ${sim.size.toFixed(2)}$ (kassza ${sim.pool.toFixed(1)}$)`];
  const fi = merged.findIndex((l) => l.startsWith("💰"));
  const out = fi >= 0 ? [...merged.slice(0, fi), ...comp, "", ...merged.slice(fi)] : [...merged, ...comp];
  return [`📊 Riport · ${hours} óra (${new Date(sinceMs).toISOString().slice(5, 10)} óta)`, ...out].join("\n").replace(/\n{3,}/g, "\n\n");
}
