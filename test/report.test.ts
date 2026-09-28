import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";
import { openDb } from "../src/db/index.js";
import { buildReport, DECISION_MIN_N } from "../src/report/index.js";
import { lateSurvivorArm } from "../src/decision/rules.js";
import { CollectorScheduler, type Collector } from "../src/collector/index.js";
import type { ParamSnapshot } from "../src/collector/types.js";

const cfg = loadConfig("config.yaml");

function seed(db: ReturnType<typeof openDb>, arm: string, n: number, pnl: (i: number) => number, closedAt: number, offset: number) {
  const tok = db.prepare("INSERT INTO tokens(chain, address, launchpad, mechanics, discovered_at) VALUES ('base', ?, 'uniswap', 'v4', ?)");
  const pos = db.prepare(`INSERT INTO positions(token_id, chain, arm, exit_plan, window_sec, opened_at, entry_price_native, size_usd, size_native, tokens_bought, tokens_remaining,
    phase, peak_price_native, closed_at, close_reason, net_pnl_usd, native_received) VALUES (?, 'base', ?, 'live', 60, ?, 1, 1, 1, 1, 0, 'closed', 1, ?, 'test', ?, 1)`);
  for (let i = 0; i < n; i++) {
    const id = Number(tok.run(`0x${(offset + i).toString(16).padStart(40, "0")}`, closedAt).lastInsertRowid);
    pos.run(id, arm, closedAt - 1000, closedAt, pnl(i));
  }
}

test("döntési tábla: ✅ csak elég pozíciónál és nulla fölötti CI-nél; --since több napot összesít", () => {
  const db = openDb(":memory:");
  const now = Date.now(), threeDaysAgo = now - 3 * 86_400_000;
  seed(db, "winner", DECISION_MIN_N + 20, (i) => 0.4 + (i % 5) * 0.05, now - 3_600_000, 1);           // sok, stabilan pozitív
  seed(db, "fewgood", 25, (i) => 0.4 + (i % 3) * 0.05, now - 3_600_000, 10_000);                       // pozitív, de kevés
  seed(db, "loser", 60, (i) => -0.3 + (i % 4) * 0.02, now - 3_600_000, 20_000);                        // negatív
  seed(db, "old", 40, () => 0.5, threeDaysAgo + 3_600_000, 30_000);                                     // 2 napnál régebbi
  const md = buildReport(db, cfg).markdown;
  const row = (arm: string) => md.split("\n").find((l) => l.includes(`| ${arm} | 60 | live |`) && l.split("|").length === 9) ?? "";
  assert.match(md, /## Döntési tábla/);
  assert.ok(row("winner").startsWith("| ✅ |"), row("winner"));
  assert.ok(row("fewgood").startsWith("| ⏳ |"), row("fewgood"));
  assert.ok(row("loser").startsWith("|  |"), row("loser"));
  assert.equal(row("old"), "");                                                                     // 24 órás ablakon kívül
  const md3 = buildReport(db, cfg, threeDaysAgo).markdown;
  assert.ok(md3.split("\n").some((l) => l.includes("| old | 60 | live |")));                         // többnapos összesítésben benne van
  assert.match(md3, /óta \(72 óra\)/);
});

test("late_survivor: csak a késői ablakban, túlélő Base/Uniswap tokenre lép be", () => {
  const s = (o: { lp?: string; chg?: unknown; dd?: unknown; sold?: unknown } = {}) => ({
    contract: { lp_owner: o.lp ?? "contract" },
    dynamics: { price_change_pct_since_launch: "chg" in o ? o.chg : 80, peak_drawdown_pct: "dd" in o ? o.dd : 20 },
    creator: { sold_pct_of_initial: "sold" in o ? o.sold : 0 },
  }) as unknown as ParamSnapshot;
  assert.equal(lateSurvivorArm("base", "uniswap", s(), 1800, 1800).enter, true);
  assert.equal(lateSurvivorArm("base", "uniswap", s(), 60, 1800).enter, false);          // nem a késői ablak
  assert.equal(lateSurvivorArm("base", "uniswap", s(), 1800, 0).enter, false);           // kikapcsolva
  assert.equal(lateSurvivorArm("robinhood", "pons", s(), 1800, 1800).enter, false);
  assert.equal(lateSurvivorArm("base", "uniswap", s({ lp: "removed" }), 1800, 1800).enter, false);
  assert.equal(lateSurvivorArm("base", "uniswap", s({ chg: -10 }), 1800, 1800).enter, false);
  assert.equal(lateSurvivorArm("base", "uniswap", s({ chg: "unknown" }), 1800, 1800).enter, false);
  assert.equal(lateSurvivorArm("base", "uniswap", s({ dd: 60 }), 1800, 1800).enter, false);
  assert.equal(lateSurvivorArm("base", "uniswap", s({ sold: 70 }), 1800, 1800).enter, false);
  assert.equal(lateSurvivorArm("base", "uniswap", s({ sold: "unknown" }), 1800, 1800).enter, true);
});

test("ütemező: a késői ablak csak a hatókörbe eső tokeneknek", () => {
  const db = openDb(":memory:");
  const sch = new CollectorScheduler(db, {} as Collector, [30, 60, 180], 16384, undefined, { sec: 1800, scope: ["base/uniswap"] });
  assert.deepEqual(sch.windowsFor({ chain: "base", launchpad: "uniswap" }), [30, 60, 180, 1800]);
  assert.deepEqual(sch.windowsFor({ chain: "robinhood", launchpad: "pons" }), [30, 60, 180]);
  const off = new CollectorScheduler(db, {} as Collector, [30, 60, 180], 16384);
  assert.deepEqual(off.windowsFor({ chain: "base", launchpad: "uniswap" }), [30, 60, 180]);
  assert.equal(cfg.evaluation.late_window_sec, 0); // kikapcsolva (2026-09-28)
  assert.deepEqual(cfg.evaluation.late_scope, ["base/uniswap"]);
});
