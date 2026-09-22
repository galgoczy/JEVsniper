import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig, ConfigSchema } from "../src/config.js";
import { openDb, ensureCompoundState, ensureDailyState } from "../src/db/index.js";
import { scoreTo100, entryQuestions } from "../src/jev/questions.js";
import { redact } from "../src/env.js";
import { parseCommand } from "../src/telegram.js";

test("config.yaml valid és a kockázati limitek a specifikáció szerintiek", () => {
  const c = loadConfig("config.yaml");
  assert.equal(c.risk.base_position_usd, 1);
  assert.equal(c.risk.max_position_usd, 10);
  assert.equal(c.risk.deposit_cap_usd, 30);
  assert.equal(c.risk.max_open_positions, 15);
  assert.equal(c.exit_plan.tp1_sell_pct + c.exit_plan.tp2_sell_pct + c.exit_plan.moon_bag_pct, 100);
});

test("hibás config elutasítva", () => {
  const c = loadConfig("config.yaml");
  const broken = structuredClone(c) as Record<string, unknown>;
  (broken.risk as Record<string, number>).max_position_usd = 0.5;
  assert.equal(ConfigSchema.safeParse(broken).success, false);
});

test("DB séma és állapot-inicializálás", () => {
  const db = openDb(":memory:");
  const cs = ensureCompoundState(db, 30, 1);
  assert.equal(cs.deposit_usd, 30);
  assert.equal(cs.position_usd, 1);
  const ds = ensureDailyState(db, "2026-09-22");
  assert.equal(ds.entries, 0);
  db.close();
});

test("Jev score → 0–100 skálázás és 12 belépési kérdés", () => {
  assert.equal(scoreTo100(0), 0);
  assert.equal(scoreTo100(9), 100);
  assert.equal(scoreTo100(4.5), 50);
  assert.equal(Object.keys(entryQuestions).length, 12);
});

test("kulcsok kitakarása a logban", () => {
  const key = "0x" + "a".repeat(64);
  assert.ok(!redact(`key=${key}`).includes(key));
  assert.ok(!redact("123456789:AAHfakefakefakefakefakefakefakefake").includes("AAHfake"));
});

test("Telegram parancs-felismerés", () => {
  assert.equal(parseCommand("/stop"), "stop");
  assert.equal(parseCommand("/panic@jevbot"), "panic");
  assert.equal(parseCommand("hello"), null);
});
