import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";
import { openDb } from "../src/db/index.js";
import { explore, wilsonLow, type Sample } from "../src/analysis/explore.js";
import { nextState, checkArms, type ArmStat } from "../src/analysis/watch.js";

const cfg = loadConfig("config.yaml");

test("szabálykereső: a valódi jelet megtalálja és az ellenőrző részen is igazolja", () => {
  // 600 token: ha holders.count ≥ 20, 60% előbb 2x; különben 5%. Determinisztikus „véletlen”.
  let seed = 7; const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
  const samples: Sample[] = Array.from({ length: 600 }, (_, i) => {
    const holders = Math.floor(rnd() * 40);
    const good = holders >= 20;
    const u = rnd();
    const outcome = good ? (u < 0.6 ? "win" : u < 0.8 ? "loss" : "neither") : (u < 0.05 ? "win" : u < 0.6 ? "loss" : "neither");
    return { at: 1_000_000 + i * 1000, chain: "base", launchpad: "uniswap", outcome, p: { holders: { count: holders }, dynamics: { buyer_acceleration: rnd() * 3 } } } as Sample;
  });
  const r = explore(samples, cfg.cost_model, { top: 5 });
  assert.ok(r.results.length > 0);
  const best = r.results[0]!;
  assert.ok(best.conds.some((c) => c.startsWith("holders.count ≥ 20") || c.startsWith("holders.count ≥ 30")), best.conds.join(","));
  assert.equal(best.holds, true);
  assert.ok(best.test.win > best.baseTest.win);
});

test("szabálykereső: tiszta zajon nem talál tartós szabályt a tetején", () => {
  let seed = 99; const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
  const samples: Sample[] = Array.from({ length: 600 }, (_, i) => {
    const u = rnd();
    return { at: i, chain: "base", launchpad: "uniswap", outcome: u < 0.15 ? "win" : u < 0.5 ? "loss" : "neither", p: { holders: { count: Math.floor(rnd() * 40) }, dynamics: { buyer_acceleration: rnd() * 3 } } } as Sample;
  });
  const r = explore(samples, cfg.cost_model, { top: 10 });
  const holds = r.results.filter((x) => x.holds).length;
  assert.ok(holds <= 6, `zajon ${holds}/10 tartott`); // lehet néhány véletlen ✔, de nem mind
  assert.ok(wilsonLow(0.5, 100) < 0.5 && wilsonLow(0.5, 100) > 0.4);
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
