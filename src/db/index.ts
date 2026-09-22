import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type DB = Database.Database;

const SCHEMA_VERSION = 1;

export function openDb(file: string): DB {
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const db = new Database(file);
  const schemaPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "schema.sql");
  db.exec(fs.readFileSync(schemaPath, "utf8"));
  db.prepare("INSERT OR IGNORE INTO meta(key, value) VALUES ('schema_version', ?)").run(String(SCHEMA_VERSION));
  return db;
}

export const nowMs = () => Date.now();
export const todayUtc = (t = Date.now()) => new Date(t).toISOString().slice(0, 10);

export function ensureDailyState(db: DB, day = todayUtc()) {
  db.prepare("INSERT OR IGNORE INTO daily_state(day) VALUES (?)").run(day);
  return db.prepare("SELECT * FROM daily_state WHERE day = ?").get(day) as {
    day: string; entries: number; realized_pnl_usd: number; jev_cost_usd: number;
    consecutive_failed_tx: number; paused_reason: string | null;
  };
}

export function ensureCompoundState(db: DB, depositUsd: number, basePositionUsd: number) {
  db.prepare(`INSERT OR IGNORE INTO compound_state(id, deposit_usd, growth_pool_usd, reserve_usd,
      working_capital_peak_usd, position_usd, updated_at) VALUES (1, ?, 0, 0, ?, ?, ?)`)
    .run(depositUsd, depositUsd, basePositionUsd, nowMs());
  return db.prepare("SELECT * FROM compound_state WHERE id = 1").get() as {
    deposit_usd: number; growth_pool_usd: number; reserve_usd: number;
    working_capital_peak_usd: number; position_usd: number; updated_at: number;
  };
}

export function logEvent(db: DB, kind: string, detail?: string) {
  db.prepare("INSERT INTO events(at, kind, detail) VALUES (?, ?, ?)").run(nowMs(), kind, detail ?? null);
}

export function openPositions(db: DB, arm = "live") {
  return db.prepare("SELECT * FROM positions WHERE arm = ? AND closed_at IS NULL").all(arm) as Array<Record<string, unknown>>;
}
