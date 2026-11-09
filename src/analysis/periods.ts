import type { Config } from "../config.js";

/** Értékelési időszakok (2026-10-07). A pozíció a nyitása szerinti időszakba tartozik. */
export interface Period { name: string; from: number; to: number | null }

export function periods(cfg: Config): Period[] {
  const ps = cfg.evaluation.periods.map((p) => ({ name: p.name, from: Date.parse(p.from), to: p.to ? Date.parse(p.to) : null }));
  return ps.length ? ps : [{ name: "teljes", from: Date.parse(`${cfg.alerts.since}T00:00:00Z`), to: null }];
}

/** Az aktuális (legutolsó, már elkezdődött) időszak; ha egyik sem kezdődött el, az első. */
export function currentPeriod(cfg: Config, now = Date.now()): Period {
  const ps = periods(cfg); const started = ps.filter((p) => p.from <= now);
  return started.length ? started[started.length - 1]! : ps[0]!;
}

/** Az aktuális időszak kezdete (ms) – a jelentések és a HUD alapértelmezett „since”-e. */
export const currentSince = (cfg: Config, now = Date.now()) => currentPeriod(cfg, now).from;
