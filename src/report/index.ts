import fs from "node:fs";
import path from "node:path";
import type { DB } from "../db/index.js";
import { nowMs } from "../db/index.js";
import type { Config } from "../config.js";

type Row = Record<string, unknown>;
const f = (v: unknown, d = 3) => (typeof v === "number" && Number.isFinite(v) ? v.toFixed(d) : "-");
const pct = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(0)}%` : "-");

/** Bootstrap 90% CI az átlagra (1000 minta). */
export function bootstrapCI(xs: number[], iters = 1000): [number, number] | null {
  if (xs.length < 3) return null;
  let seed = 12345; const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
  const means: number[] = [];
  for (let i = 0; i < iters; i++) { let s = 0; for (let j = 0; j < xs.length; j++) s += xs[Math.floor(rnd() * xs.length)]!; means.push(s / xs.length); }
  means.sort((a, b) => a - b);
  return [means[Math.floor(iters * 0.05)]!, means[Math.floor(iters * 0.95)]!];
}
export const median = (xs: number[]) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2; };

/**
 * 9. Napi riport (markdown + rövid Telegram-összefoglaló). Élő és árnyék külön, rezsimenként bontva.
 * Minden szám közvetlenül a DB-ből; a verify a számok egyezését ellenőrzi.
 */
export function buildReport(db: DB, cfg: Config, sinceMs = nowMs() - 86_400_000): { markdown: string; telegram: string } {
  const now = nowMs();
  const L: string[] = [`# Jev Sniper napi riport – ${new Date(now).toISOString().slice(0, 16)} UTC`, `Időszak: utolsó ${Math.round((now - sinceMs) / 3_600_000)} óra. Mód: ${cfg.mode}.`, ""];

  // --- tölcsér
  const newTok = db.prepare("SELECT chain, launchpad, COUNT(*) n FROM tokens WHERE discovered_at > ? GROUP BY chain, launchpad").all(sinceMs) as Row[];
  const filtered = db.prepare("SELECT reason, COUNT(DISTINCT token_id) n FROM filter_log WHERE at > ? GROUP BY reason ORDER BY n DESC").all(sinceMs) as Row[];
  const evaluated = (db.prepare("SELECT COUNT(DISTINCT token_id) n FROM jev_calls WHERE purpose='entry' AND ok=1 AND called_at > ?").get(sinceMs) as { n: number }).n;
  const passed = (db.prepare("SELECT COUNT(DISTINCT token_id) n FROM decisions WHERE decided_at > ?").get(sinceMs) as { n: number }).n;
  const liveEntries = (db.prepare("SELECT COUNT(*) n FROM positions WHERE arm='live' AND opened_at > ?").get(sinceMs) as { n: number }).n;
  const liveRuleWouldEnter = (db.prepare("SELECT COUNT(DISTINCT token_id) n FROM decisions WHERE arm='live_rule' AND enter=1 AND window_sec=? AND decided_at > ?").get(cfg.evaluation.live_window_sec, sinceMs) as { n: number }).n;
  const blocked = db.prepare("SELECT reason, COUNT(*) n FROM decisions WHERE arm='live' AND enter=0 AND decided_at > ? GROUP BY reason ORDER BY n DESC").all(sinceMs) as Row[];
  L.push("## Tölcsér", `- Új tokenek: ${newTok.map((r) => `${r.chain}/${r.launchpad}=${r.n}`).join(", ") || "0"}`,
    `- Kiesett a kemény szűrőn: ${filtered.map((r) => `${r.reason}=${r.n}`).join(", ") || "0"}`,
    `- Jev-vel értékelt: ${evaluated}; szűrőn átment (döntés született): ${passed}`,
    `- Élő szabály belépne (60 mp): ${liveRuleWouldEnter}; élő belépés: ${liveEntries}${blocked.length ? `; blokkolva: ${blocked.map((r) => `${r.reason}=${r.n}`).join(", ")}` : ""}`, "");

  // --- élő
  const live = db.prepare("SELECT * FROM positions WHERE arm='live' AND closed_at > ?").all(sinceMs) as Array<{ net_pnl_usd: number; gas_usd: number; jev_cost_usd: number; size_usd: number; close_reason: string; native_received: number; size_native: number }>;
  const liveNet = live.reduce((s, p) => s + (p.net_pnl_usd ?? 0), 0);
  const fixed = live.reduce((s, p) => s + (p.gas_usd ?? 0) + (p.jev_cost_usd ?? 0), 0), sizeSum = live.reduce((s, p) => s + p.size_usd, 0);
  const fills = db.prepare("SELECT status, COUNT(*) n, AVG(real_gas_usd) g, AVG(est_gas_usd) eg FROM fills WHERE is_live=1 AND at > ? GROUP BY status").all(sinceMs) as Row[];
  const jevStats = db.prepare("SELECT purpose, COUNT(*) n, SUM(ok=0) err, SUM(cost_usd) c, AVG(latency_ms) ms FROM jev_calls WHERE called_at > ? GROUP BY purpose").all(sinceMs) as Row[];
  const openLive = db.prepare("SELECT COUNT(*) n FROM positions WHERE arm='live' AND closed_at IS NULL").get() as { n: number };
  L.push("## Élő", `- Lezárt: ${live.length}, nyerő: ${live.filter((p) => (p.net_pnl_usd ?? 0) > 0).length}, nettó: ${f(liveNet, 3)} USD, nyitott: ${openLive.n}`,
    `- Fix költségek (gas+Jev) / pozícióméret: ${sizeSum ? pct(fixed, sizeSum) : "-"} (${f(fixed, 4)} / ${f(sizeSum, 2)} USD)`,
    `- Tx-ek: ${fills.map((r) => `${r.status}=${r.n} (gas valódi ${f(r.g, 4)} vs becsült ${f(r.eg, 4)})`).join(", ") || "nincs"}`,
    `- Kilépési okok: ${Object.entries(live.reduce((m, p) => ((m[p.close_reason ?? "?"] = (m[p.close_reason ?? "?"] ?? 0) + 1), m), {} as Record<string, number>)).map(([k, v]) => `${k}=${v}`).join(", ") || "-"}`,
    `- Jev-hívások: ${jevStats.map((r) => `${r.purpose}=${r.n} (hiba ${r.err}, ${f(r.c, 4)} USD, ${f(r.ms, 0)} ms)`).join("; ") || "nincs"}`, "");

  // --- compound
  const cs = db.prepare("SELECT * FROM compound_state WHERE id=1").get() as Row | undefined;
  const sizes = db.prepare("SELECT at, old_position_usd o, new_position_usd n, reason FROM size_changes ORDER BY id DESC LIMIT 5").all() as Row[];
  if (cs) L.push("## Compound", `- Betét ${f(cs.deposit_usd, 2)}, kassza ${f(cs.growth_pool_usd, 2)}, tartalék ${f(cs.reserve_usd, 2)} (elkerítve, kézzel kiutalható), pozícióméret ${f(cs.position_usd, 2)} USD`,
    `- Forgó tőke ${f(Number(cs.deposit_usd) + Number(cs.growth_pool_usd), 2)}, csúcs ${f(cs.working_capital_peak_usd, 2)} (visszaesés ${pct(Number(cs.working_capital_peak_usd) - Number(cs.deposit_usd) - Number(cs.growth_pool_usd), Number(cs.working_capital_peak_usd))})`,
    `- Méretváltozások: ${sizes.map((s) => `${new Date(Number(s.at)).toISOString().slice(5, 16)} ${s.o}→${s.n} (${s.reason})`).join("; ") || "nincs"}`, "");

  // --- árnyék karonként/ablakonként/tervenként
  const shadow = db.prepare(`SELECT arm, window_sec, exit_plan, regime, net_pnl_usd, native_received, size_native, close_reason, peak_price_native, entry_price_native FROM positions p
    LEFT JOIN (SELECT token_id tid, regime FROM decisions WHERE arm='live_rule' GROUP BY token_id) d ON d.tid = p.token_id
    WHERE arm NOT IN ('live','day1_test') AND closed_at > ? AND close_reason != 'invalid_no_tokens'`).all(sinceMs) as Array<{ arm: string; window_sec: number; exit_plan: string; regime: string | null; net_pnl_usd: number; native_received: number; size_native: number; close_reason: string; peak_price_native: number; entry_price_native: number }>;
  const groups = new Map<string, typeof shadow>();
  for (const p of shadow) { const k = `${p.arm}|${p.window_sec}|${p.exit_plan}`; (groups.get(k) ?? groups.set(k, []).get(k)!).push(p); }
  const rcLive = shadow.filter((p) => p.arm === "random_control" && p.exit_plan === "live" && p.window_sec === cfg.evaluation.live_window_sec);
  const rcMean = rcLive.length ? rcLive.reduce((s, p) => s + p.net_pnl_usd, 0) / rcLive.length : null;
  L.push("## Árnyékkarok (lezárt pozíciók)", `random_control (60 mp, élő terv) átlag nettó: ${f(rcMean, 3)} USD, n=${rcLive.length}`, "",
    "| kar | ablak | terv | n | találat | medián x | átlag x | nettó Σ | átlag nettó | 90% CI | top3 nélkül | vs random |", "|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const [k, ps] of [...groups.entries()].sort()) {
    const [arm, w, plan] = k.split("|");
    const nets = ps.map((p) => p.net_pnl_usd), mults = ps.map((p) => (p.size_native ? p.native_received / p.size_native : 0));
    const mean = nets.reduce((s, x) => s + x, 0) / nets.length, ci = bootstrapCI(nets);
    const sorted = [...nets].sort((a, b) => b - a), noTop3 = sorted.slice(3).reduce((s, x) => s + x, 0);
    L.push(`| ${arm} | ${w} | ${plan} | ${ps.length} | ${pct(nets.filter((x) => x > 0).length, nets.length)} | ${f(median(mults), 2)} | ${f(mults.reduce((s, x) => s + x, 0) / mults.length, 2)} | ${f(nets.reduce((s, x) => s + x, 0), 2)} | ${f(mean, 3)} | ${ci ? `${f(ci[0], 2)}…${f(ci[1], 2)}` : "-"} | ${f(noTop3, 2)} | ${rcMean !== null ? f(mean - rcMean, 3) : "-"} |`);
  }
  // moon bag statisztika: hány pozíció ért 5x/10x/20x-et (csúcs alapján), trailing kilépések
  const peaks = shadow.filter((p) => p.exit_plan === "live").map((p) => p.peak_price_native / p.entry_price_native);
  const reached = (m: number) => peaks.filter((x) => x >= m).length;
  const trailing = shadow.filter((p) => p.close_reason?.startsWith("trailing")).length;
  L.push("", `Csúcs-szorzók (élő terv): ≥2x ${reached(2)}, ≥5x ${reached(5)}, ≥10x ${reached(10)}, ≥20x ${reached(20)} a ${peaks.length}-ból; trailing-kilépések: ${trailing}`,
    `Rezsim szerinti bontás: ${Object.entries(shadow.reduce((m, p) => { const r = p.regime ?? "?"; m[r] = m[r] ?? { n: 0, s: 0 }; m[r].n++; m[r].s += p.net_pnl_usd; return m; }, {} as Record<string, { n: number; s: number }>)).map(([r, v]) => `${r}: n=${v.n}, átlag ${f(v.s / v.n, 3)}`).join("; ") || "-"}`, "");

  // --- kalibráció: Jev P(tp1_first) sávok vs. valós kimenet (60 mp ablak, 24h lezárt kimenetek)
  const cal = db.prepare(`SELECT j.answers_json a, o.first_hit h, o.max_multiple mx FROM jev_calls j JOIN token_outcomes o ON o.token_id = j.token_id
    WHERE j.purpose='entry' AND j.ok=1 AND j.window_sec=? AND o.done_at IS NOT NULL`).all(cfg.evaluation.live_window_sec) as Array<{ a: string; h: string | null; mx: number }>;
  const bins = [0, 0.2, 0.35, 0.5, 0.7, 1.01];
  const calRows = bins.slice(0, -1).map((lo, i) => { const hi = bins[i + 1]!; const xs = cal.filter((r) => { const p = JSON.parse(r.a).outcome?.probabilities?.tp1_first ?? 0; return p >= lo && p < hi; }); return { lo, hi, n: xs.length, tp1: xs.filter((r) => r.h === "tp1_first").length }; });
  L.push("## Kalibráció (P(2x előbb) sávok, 24h lezárt kimenetek)", "| sáv | n | valós 2x arány |", "|---|---|---|", ...calRows.map((r) => `| ${r.lo}–${r.hi} | ${r.n} | ${pct(r.tp1, r.n)} |`), "");

  // --- címke-informativitás: melyik címkeérték mellett mekkora a 2x arány
  const labelKeys = ["contract_risk", "creator_profile", "wallet_pattern", "crowd_type", "dev_behavior", "trade_pattern", "copycat", "entry_timing"];
  const info: string[] = [];
  for (const key of labelKeys) {
    const by = new Map<string, { n: number; tp1: number }>();
    for (const r of cal) { const v = JSON.parse(r.a)[key]?.choice ?? "?"; const e = by.get(v) ?? { n: 0, tp1: 0 }; e.n++; if (r.h === "tp1_first") e.tp1++; by.set(v, e); }
    if (by.size) info.push(`- ${key}: ${[...by.entries()].sort((a, b) => b[1].n - a[1].n).map(([v, e]) => `${v}=${pct(e.tp1, e.n)} (${e.n})`).join(", ")}`);
  }
  L.push("## Címke-informativitás (2x arány címkeértékenként)", ...(info.length ? info : ["- még nincs 24 órás lezárt kimenet"]), "");

  // --- egyéb: kimenet-követés, listák, rezsim-idővonal, vesztes sorozat, Jev-hibaarány
  const oc = db.prepare("SELECT COUNT(*) n, SUM(first_hit='tp1_first') tp1, SUM(first_hit='stop_first') stop, SUM(done_at IS NOT NULL) done, SUM(max_multiple>=2) m2, SUM(max_multiple>=5) m5, SUM(max_multiple>=10) m10 FROM token_outcomes WHERE ref_at > ?").get(sinceMs) as Row;
  const lists = db.prepare("SELECT list, COUNT(*) n, SUM(occurrences>=5) scored FROM wallet_lists GROUP BY list").all() as Row[];
  const regimes = db.prepare("SELECT regime, source, at FROM regime_log WHERE at > ? ORDER BY at").all(sinceMs) as Row[];
  const streak = (() => { let cur = 0, worst = 0; for (const p of db.prepare("SELECT net_pnl_usd n FROM positions WHERE arm='live' AND closed_at IS NOT NULL ORDER BY closed_at").all() as { n: number }[]) { cur = p.n < 0 ? cur + 1 : 0; worst = Math.max(worst, cur); } return worst; })();
  const jevErr = db.prepare("SELECT COUNT(*) n, SUM(ok=0) e FROM jev_calls WHERE called_at > ?").get(sinceMs) as { n: number; e: number };
  L.push("## Egyéb", `- Kimenet-követés: ${oc.n} token, 2x előbb ${oc.tp1 ?? 0}, −40% előbb ${oc.stop ?? 0}, lezárt 24h ${oc.done ?? 0}; csúcs ≥2x ${oc.m2 ?? 0}, ≥5x ${oc.m5 ?? 0}, ≥10x ${oc.m10 ?? 0}`,
    `- Saját listák: ${lists.map((r) => `${r.list}=${r.n} (pontozott ${r.scored})`).join(", ") || "még üresek"}`,
    `- Élő vesztes sorozat (max): ${streak}; Jev-hibaarány: ${pct(jevErr.e ?? 0, jevErr.n)} (${jevErr.e ?? 0}/${jevErr.n})`,
    `- Rezsim-idővonal: ${regimes.map((r) => `${new Date(Number(r.at)).toISOString().slice(11, 16)} ${r.regime}${r.source !== "jev" ? `(${r.source})` : ""}`).join(" → ") || "-"}`, "");

  const telegram = [`📊 Napi riport (${cfg.mode})`, `Tölcsér: ${newTok.reduce((s, r) => s + Number(r.n), 0)} új → ${passed} átment → élő szabály ${liveRuleWouldEnter} → élő belépés ${liveEntries}`,
    `Élő: ${live.length} lezárt, nettó ${f(liveNet, 2)} USD, nyitott ${openLive.n}`,
    `Árnyék: random_control ${f(rcMean, 3)} (n=${rcLive.length}); ` + ["live_rule", "jev_direct_0.4", "rule_score"].map((a) => { const g = groups.get(`${a}|${cfg.evaluation.live_window_sec}|live`); return `${a} ${g ? f(g.reduce((s, p) => s + p.net_pnl_usd, 0) / g.length, 3) + ` (n=${g.length})` : "-"}`; }).join(", "),
    `Kimenetek: 2x ${oc.tp1 ?? 0} / −40% ${oc.stop ?? 0} a ${oc.n}-ból; Jev ${jevErr.n} hívás, ${f(jevStats.reduce((s, r) => s + Number(r.c ?? 0), 0), 4)} USD`,
    cs ? `Compound: méret ${f(cs.position_usd, 2)} USD, kassza ${f(cs.growth_pool_usd, 2)}, tartalék ${f(cs.reserve_usd, 2)}` : ""].filter(Boolean).join("\n");
  return { markdown: L.join("\n"), telegram };
}

export function writeReport(db: DB, cfg: Config): { file: string; telegram: string } {
  const { markdown, telegram } = buildReport(db, cfg);
  fs.mkdirSync(cfg.report.output_dir, { recursive: true });
  const file = path.join(cfg.report.output_dir, `${new Date().toISOString().slice(0, 10)}.md`);
  fs.writeFileSync(file, markdown);
  return { file, telegram };
}
