import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";
import { openDb } from "../src/db/index.js";
import { explore, loadSamples, type Sample } from "../src/analysis/explore.js";
import { nextState, checkArms, type ArmStat } from "../src/analysis/watch.js";

const cfg = loadConfig("config.yaml");

const mk = (seed0: number, n: number, signal: boolean): Sample[] => {
  let seed = seed0; const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
  return Array.from({ length: n }, (_, i) => {
    const holders = Math.floor(rnd() * 40);
    const base = signal ? (holders >= 20 ? 0.3 : -0.3) : -0.1;
    const value = base + (rnd() - 0.5) * 1.2; // zaj ±0,6
    return { at: 1_000_000 + i * 1000, chain: "base", launchpad: "uniswap", value, open: false,
      p: { holders: { count: holders }, dynamics: { buyer_acceleration: rnd() * 3, peak_drawdown_pct: rnd() * 60 }, buyers: { bot_ratio: rnd() }, contract: { liquidity_usd: rnd() * 20000 } } } as Sample;
  });
};

test("szabálykereső: a valódi jelet megtalálja és az ellenőrző részen is igazolja", () => {
  const r = explore(mk(7, 600, true), { top: 5 });
  const best = r.results[0]!;
  assert.ok(best.conds.some((c) => c.startsWith("holders.count ≥ 20") || c.startsWith("holders.count ≥ 30")), best.conds.join(","));
  assert.equal(best.holds, true);
  assert.ok(best.test.mean > best.baseTest.mean);
});

test("szabálykereső: tiszta zajon (szinte) nem jelöl tartós szabályt", () => {
  let total = 0;
  for (const seed of [1, 2, 3, 4, 5]) total += explore(mk(seed, 900, false), { top: 20 }).results.filter((x) => x.holds).length;
  assert.ok(total <= 5, `zajon összesen ${total}/100 hamis ✔`);
});

test("szabálykereső: nyitott pozíció értéke az utolsó áron, a friss pozíciók kimaradnak", () => {
  const db = openDb(":memory:");
  const now = Date.now();
  const tok = db.prepare("INSERT INTO tokens(chain, address, launchpad, discovered_at) VALUES ('base', ?, 'uniswap', ?)");
  const snap = db.prepare("INSERT INTO snapshots(token_id, window_sec, taken_at, params_json) VALUES (?, 60, ?, '{}')");
  const pos = db.prepare(`INSERT INTO positions(token_id, chain, arm, exit_plan, window_sec, opened_at, entry_price_native, size_usd, size_native, tokens_bought, tokens_remaining,
    phase, closed_at, net_pnl_usd, native_received, last_price_native, gas_usd, liquidity_at_entry) VALUES (?, 'base', 'base_uni_all', 'live', 60, ?, 1, 1, 0.0004, 0.0004, ?, ?, ?, ?, 0, ?, 0.004, 100)`);
  const a = Number(tok.run("0xa", now).lastInsertRowid); snap.run(a, now);
  pos.run(a, now - 10 * 3_600_000, 0, "closed", now - 3_600_000, -0.5, null);                 // lezárt: −0,5
  const b = Number(tok.run("0xb", now).lastInsertRowid); snap.run(b, now);
  pos.run(b, now - 10 * 3_600_000, 0.0004, "pre_tp1", null, null, 2);                          // nyitott, ár 2x → kb. +0,9
  const c = Number(tok.run("0xc", now).lastInsertRowid); snap.run(c, now);
  pos.run(c, now - 3_600_000, 0.0004, "pre_tp1", null, null, 1);                              // 1 órás → kimarad
  const r = loadSamples(db, cfg.cost_model, { windowSec: 60, plan: "live", sinceMs: now - 86_400_000, minAgeMs: 6 * 3_600_000, now });
  assert.equal(r.samples.length, 2); assert.equal(r.young, 1);
  const closed = r.samples.find((x) => !x.open)!, open = r.samples.find((x) => x.open)!;
  assert.ok(Math.abs(closed.value + 0.5) < 1e-9);
  assert.ok(open.value > 0.8 && open.value < 1.0, String(open.value));
});

test("figyelő: állapotváltások hiszterézissel", () => {
  const st = (n: number, lo: number): ArmStat => ({ key: "x|60|live", n, mean: lo + 0.1, ci: [lo, lo + 0.2] });
  assert.equal(nextState("none", st(10, 0.1)), "none");            // kevés adat
  assert.equal(nextState("none", st(30, 0.05)), "promising");
  assert.equal(nextState("none", st(120, 0.05)), "candidate");
  assert.equal(nextState("promising", st(40, -0.01)), "promising"); // margón belül marad
  assert.equal(nextState("promising", st(40, -0.05)), "none");      // kiesik
  assert.equal(nextState("none", st(40, -0.01)), "none");
});

test("figyelő: csak változáskor szól, a random_control kimarad", () => {
  const db = openDb(":memory:");
  const now = Date.now();
  const tok = db.prepare("INSERT INTO tokens(chain, address, discovered_at) VALUES ('base', ?, ?)");
  const pos = db.prepare(`INSERT INTO positions(token_id, chain, arm, exit_plan, window_sec, opened_at, entry_price_native, size_usd, size_native, tokens_bought, tokens_remaining,
    phase, closed_at, close_reason, net_pnl_usd) VALUES (?, 'base', ?, 'live', 60, ?, 1, 1, 1, 1, 0, 'closed', ?, 'test', ?)`);
  for (let i = 0; i < 30; i++) {
    const a = Number(tok.run(`0xa${i}`, now).lastInsertRowid), b = Number(tok.run(`0xb${i}`, now).lastInsertRowid);
    pos.run(a, "good_arm", now - 5000, now - 1000, 0.3 + (i % 3) * 0.05);
    pos.run(b, "random_control", now - 5000, now - 1000, 0.5);
  }
  const m1 = checkArms(db, now - 86_400_000);
  assert.equal(m1.length, 1); assert.match(m1[0]!, /Ígéretes: good_arm/);
  assert.equal(checkArms(db, now - 86_400_000).length, 0);           // nincs változás → nincs üzenet
});

test("állás: stratégiánként egy sor, véletlen kontroll külön, parancs felismerve", async () => {
  const { standings } = await import("../src/analysis/standings.js");
  const { parseCommand } = await import("../src/telegram.js");
  const db = openDb(":memory:");
  const now = Date.now();
  const tok = db.prepare("INSERT INTO tokens(chain, address, discovered_at) VALUES ('base', ?, ?)");
  const pos = db.prepare(`INSERT INTO positions(token_id, chain, arm, exit_plan, window_sec, opened_at, entry_price_native, size_usd, size_native, tokens_bought, tokens_remaining,
    phase, closed_at, close_reason, net_pnl_usd) VALUES (?, 'base', ?, ?, 60, ?, 1, 1, 1, 1, 0, 'closed', ?, 'test', ?)`);
  for (let i = 0; i < 25; i++) {
    const a = Number(tok.run(`0xs${i}`, now).lastInsertRowid);
    pos.run(a, "arm_a", "live", now - 5000, now - 1000, 0.3 + (i % 3) * 0.05);
    pos.run(a, "arm_a", "B", now - 5000, now - 1000, 0.5);
    pos.run(a, "random_control", "live", now - 5000, now - 1000, -0.2);
  }
  const txt = standings(db, now - 86_400_000, 60, now);
  assert.match(txt, /Véletlen kontroll \(60s, élő terv\): -0\.20 \(n=25\)/);
  assert.match(txt, /• arm_a: \+0\.35 \(n=25\) ⏳; legjobb 60s\/B: \+0\.50 \(n=25\)/);
  assert.doesNotMatch(txt, /• random_control/);
  assert.equal(parseCommand("/allas"), "allas");
});

test("állás: nyitott pozíciók az utolsó áron is látszanak (lassan záruló karok)", async () => {
  const { standings } = await import("../src/analysis/standings.js");
  const { loadConfig } = await import("../src/config.js");
  const cfg = loadConfig("config.yaml");
  const db = openDb(":memory:");
  const now = Date.now();
  const tok = db.prepare("INSERT INTO tokens(chain, address, discovered_at) VALUES ('robinhood', ?, ?)");
  const pos = db.prepare(`INSERT INTO positions(token_id, chain, arm, exit_plan, window_sec, opened_at, entry_price_native, size_usd, size_native, tokens_bought, tokens_remaining,
    phase, last_price_native, gas_usd, liquidity_at_entry) VALUES (?, 'robinhood', 'grad_15_hold', 'live', 0, ?, 1, 1, 0.0004, 0.0004, 0.0004, 'pre_tp1', 1.5, 0.025, 1000)`);
  for (let i = 0; i < 5; i++) pos.run(Number(tok.run(`0xg${i}`, now).lastInsertRowid), now - 3_600_000);
  const txt = standings(db, now - 86_400_000, 60, now, cfg);
  assert.match(txt, /• grad_15_hold: még nincs lezárt; nyitottakkal ~\+0\.4\d \(n=5, nyitott 5\)/);
});
