import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig, ConfigSchema } from "../src/config.js";
import { openDb, ensureCompoundState, ensureDailyState } from "../src/db/index.js";
import { scoreTo100, entryQuestions } from "../src/jev/questions.js";
import { redact, registerSecrets } from "../src/env.js";
import { parseCommand } from "../src/telegram.js";

test("config.yaml valid és a kockázati limitek a specifikáció szerintiek", () => {
  const c = loadConfig("config.yaml");
  assert.equal(c.risk.base_position_usd, 2);
  assert.equal(c.evaluation.shadow_size_usd, 1);
  assert.equal(c.risk.max_position_usd, null);
  assert.equal(c.risk.deposit_cap_usd, 30);
  assert.equal(c.risk.max_open_positions, 15);
  assert.equal(c.exit_plan.tp1_sell_pct + c.exit_plan.tp2_sell_pct + c.exit_plan.moon_bag_pct, 100);
});

test("hibás config elutasítva", () => {
  const c = loadConfig("config.yaml");
  const broken = structuredClone(c) as Record<string, unknown>;
  (broken.risk as Record<string, number>).max_position_usd = 0.5; // ha van plafon, nem lehet az alap alatt
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

test("kulcsok kitakarása a logban, tx-hash nem", () => {
  const key = "0x" + "a".repeat(64);
  registerSecrets([key]);
  assert.ok(!redact(`key=${key}`).includes(key));
  const hash = "0x" + "b".repeat(64);
  assert.ok(redact(`hash=${hash}`).includes(hash));
  assert.ok(!redact("123456789:AAHfakefakefakefakefakefakefakefake").includes("AAHfake"));
});

test("Telegram parancs-felismerés", () => {
  assert.equal(parseCommand("/stop"), "stop");
  assert.equal(parseCommand("/panic@jevbot"), "panic");
  assert.equal(parseCommand("hello"), null);
});

test("értékelési időszakok: az aktuális a legutolsó elkezdődött; a HUD lezárt időszaka csak a vége után jelenik meg", async () => {
  const { currentPeriod, periods } = await import("../src/analysis/periods.js");
  const { loadConfig } = await import("../src/config.js");
  const base = loadConfig("config.yaml");
  const cfg = { ...base, evaluation: { ...base.evaluation, periods: [{ name: "1", from: "2026-09-30T00:00:00Z", to: "2026-10-07T22:00:00Z" }, { name: "2", from: "2026-10-07T22:00:00Z" }] } };
  assert.equal(periods(cfg).length, 2);
  assert.equal(currentPeriod(cfg, Date.parse("2026-10-07T21:59:59Z")).name, "1");
  assert.equal(currentPeriod(cfg, Date.parse("2026-10-07T22:00:00Z")).name, "2");
  assert.equal(currentPeriod({ ...cfg, evaluation: { ...cfg.evaluation, periods: [] } }).from, Date.parse(`${base.alerts.since}T00:00:00Z`));
  const { openDb } = await import("../src/db/index.js");
  const { hudPeriods } = await import("../src/hud/data.js");
  const db = openDb(":memory:");
  assert.equal(hudPeriods(db, cfg, Date.parse("2026-10-07T21:00:00Z")).length, 0);
  const p = hudPeriods(db, cfg, Date.parse("2026-10-08T06:00:00Z"));
  assert.equal(p.length, 1); assert.ok(p[0]!.rows.some((r) => r.group === "BNB" && r.arm === "bnb_all60_d5"));
  db.close();
});
