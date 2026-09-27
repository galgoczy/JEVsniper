import type { DB } from "../db/index.js";
import { nowMs } from "../db/index.js";
import { bootstrapCI, DECISION_MIN_N } from "../report/index.js";

/**
 * Futás közbeni figyelő: óránként újraszámolja minden (kar, ablak, terv) kombináció eredményét egy rögzített
 * kezdőnaptól, és csak ÁLLAPOTVÁLTÁSKOR szól. A szabályokon nem változtat – csak jelez, hogy érdemes ránézni.
 *
 * Állapotok (előre rögzített szabály, ugyanaz, mint a riport döntési táblájában):
 *  candidate – élesítés-jelölt: legalább DECISION_MIN_N pozíció és a 90% CI alsó határa > 0
 *  promising – legalább MIN_N pozíció és a 90% CI alsó határa > 0
 *  none      – egyik sem
 * Hiszterézis: egy már ígéretes kombináció csak akkor esik vissza, ha a CI alsó határa EXIT_MARGIN alá megy,
 * így a határ körüli ingadozás nem okoz riasztás-áradatot.
 */
export const MIN_N = 20;
export const EXIT_MARGIN = -0.02;
export type ArmState = "none" | "promising" | "candidate";

export interface ArmStat { key: string; n: number; mean: number; ci: [number, number] | null }

export function armStats(db: DB, sinceMs: number): ArmStat[] {
  const rows = db.prepare(`SELECT arm, window_sec, exit_plan, net_pnl_usd FROM positions
    WHERE arm NOT IN ('live','day1_test') AND closed_at > ? AND opened_at > ? AND close_reason NOT LIKE 'invalid%'`).all(sinceMs, sinceMs) as Array<{ arm: string; window_sec: number; exit_plan: string; net_pnl_usd: number }>;
  const g = new Map<string, number[]>();
  for (const r of rows) { const k = `${r.arm}|${r.window_sec}|${r.exit_plan}`; (g.get(k) ?? g.set(k, []).get(k)!).push(r.net_pnl_usd); }
  return [...g.entries()].map(([key, xs]) => ({ key, n: xs.length, mean: xs.reduce((a, b) => a + b, 0) / xs.length, ci: bootstrapCI(xs) }));
}

export function nextState(prev: ArmState, s: ArmStat): ArmState {
  if (!s.ci || s.n < MIN_N) return "none";
  const lo = s.ci[0];
  if (lo > 0) return s.n >= DECISION_MIN_N ? "candidate" : "promising";
  if (prev !== "none" && lo >= EXIT_MARGIN) return prev; // hiszterézis: a margóig megtartja az állapotát
  return "none";
}

const RANK: Record<ArmState, number> = { none: 0, promising: 1, candidate: 2 };

/** Egy figyelő-kör: állapotváltások üzenetei (és az állapotok mentése). A random_control kimarad (az a viszonyítási alap). */
export function checkArms(db: DB, sinceMs: number): string[] {
  const prevRows = db.prepare("SELECT key, state FROM arm_states").all() as Array<{ key: string; state: ArmState }>;
  const prev = new Map(prevRows.map((r) => [r.key, r.state]));
  const save = db.prepare(`INSERT INTO arm_states(key, state, n, mean, ci_lo, ci_hi, updated_at) VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(key) DO UPDATE SET state = excluded.state, n = excluded.n, mean = excluded.mean, ci_lo = excluded.ci_lo, ci_hi = excluded.ci_hi, updated_at = excluded.updated_at`);
  const stats = armStats(db, sinceMs);
  const rc = stats.find((s) => s.key.startsWith("random_control|60|live"));
  const msgs: string[] = [];
  for (const s of stats) {
    if (s.key.startsWith("random_control|")) continue;
    const p = prev.get(s.key) ?? "none", nx = nextState(p, s);
    save.run(s.key, nx, s.n, s.mean, s.ci?.[0] ?? null, s.ci?.[1] ?? null, nowMs());
    if (nx === p) continue;
    const [arm, w, plan] = s.key.split("|");
    const ci = s.ci ? `${s.ci[0].toFixed(2)}…${s.ci[1].toFixed(2)}` : "-";
    const line = `${arm} @${w}s, ${plan} terv: n=${s.n}, átlag ${s.mean.toFixed(3)} USD, 90% CI ${ci}${rc ? ` (véletlen: ${rc.mean.toFixed(3)})` : ""}`;
    if (nx === "candidate") msgs.push(`✅ ÉLESÍTÉS-JELÖLT (még egy független héten is igazolni kell): ${line}`);
    else if (RANK[nx] > RANK[p]) msgs.push(`⏳ Ígéretes: ${line}`);
    else msgs.push(`↘️ Kiesett (${p === "candidate" ? "jelöltből" : "ígéretesből"}): ${line}`);
  }
  return msgs;
}
