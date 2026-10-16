import type { DB } from "../db/index.js";
import { bootstrapCI } from "../report/index.js";

/**
 * Csalásszűrt nézet (2026-10-11): a Base karok lezárt árnyék-pozíciói (élő terv) a base_scam_checks szerint bontva –
 * TISZTA (vizsgálva, nincs jel), JELZETT (bármely jel), NEM VIZSGÁLT (a szűrő bekötése előtti / hibás vizsgálat).
 * A döntéshez a TISZTA sor számít: a jelzett tokenek nyeresége élesben nem érhető el (zárt, áremelő rendszerek).
 */
export const SCAM_VIEW_ARMS: Array<[string, number]> = [["rule_v2_strict", 60], ["rule_v2", 60], ["rule_v2_nofactory", 60], ["base_uni_hold", 30], ["base_uni_hold_nofactory", 30], ["base_uni_all", 60], ["random_control", 60]];

export interface ScamViewRow { arm: string; window: number; clean: number[]; flagged: number[]; unscanned: number; openClean: number }

export function scamView(db: DB, sinceMs: number): ScamViewRow[] {
  const q = db.prepare(`SELECT p.net_pnl_usd v, p.closed_at c, s.flags f, s.token_id sid FROM positions p
    LEFT JOIN base_scam_checks s ON s.token_id = p.token_id AND s.error IS NULL
    WHERE p.chain = 'base' AND p.arm = ? AND p.window_sec = ? AND p.exit_plan = 'live' AND p.opened_at > ? AND COALESCE(p.close_reason,'') NOT LIKE 'invalid%'`);
  return SCAM_VIEW_ARMS.map(([arm, w]) => {
    const rows = q.all(arm, w, sinceMs) as Array<{ v: number | null; c: number | null; f: string | null; sid: number | null }>;
    const closed = rows.filter((r) => r.c !== null && r.v !== null);
    return { arm, window: w, clean: closed.filter((r) => r.sid !== null && !r.f).map((r) => r.v!), flagged: closed.filter((r) => r.sid !== null && !!r.f).map((r) => r.v!),
      unscanned: closed.filter((r) => r.sid === null).length, openClean: rows.filter((r) => r.c === null && r.sid !== null && !r.f).length };
  });
}

export function scamViewText(db: DB, sinceMs: number): string {
  const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const s = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(2)}`;
  const lines = ["🛡️ Csalásszűrt nézet (Base, élő terv) – a döntéshez a TISZTA számít:"];
  for (const r of scamView(db, sinceMs)) {
    if (!r.clean.length && !r.flagged.length && !r.unscanned) continue;
    const ci = bootstrapCI(r.clean);
    lines.push(`• ${r.arm} ${r.window}s: TISZTA ${r.clean.length ? `${s(avg(r.clean))} (n=${r.clean.length}${ci ? `, 90% CI ${s(ci[0])}…${s(ci[1])}` : ""}${ci && ci[0] > 0 ? " ⏳" : ""})` : "–"}`
      + `${r.openClean ? `, nyitott ${r.openClean}` : ""} | jelzett ${r.flagged.length ? `${s(avg(r.flagged))} (n=${r.flagged.length})` : "–"}${r.unscanned ? ` | nem vizsgált ${r.unscanned}` : ""}`);
  }
  return lines.join("\n");
}
