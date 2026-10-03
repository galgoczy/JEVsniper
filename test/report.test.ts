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

test("riport: az időszak előtt nyitott, de most lezáruló pozíció nem számít (régi, esetleg hibás mérés)", () => {
  const db = openDb(":memory:");
  const now = Date.now();
  const tok = db.prepare("INSERT INTO tokens(chain, address, launchpad, mechanics, discovered_at) VALUES ('base', ?, 'uniswap', 'v4', ?)");
  const pos = db.prepare(`INSERT INTO positions(token_id, chain, arm, exit_plan, window_sec, opened_at, entry_price_native, size_usd, size_native, tokens_bought, tokens_remaining,
    phase, peak_price_native, closed_at, close_reason, net_pnl_usd, native_received) VALUES (?, 'base', 'stale_arm', 'live', 60, ?, 1, 1, 1, 1, 0, 'closed', 1, ?, 'time_limit_7d', 0.5, 1)`);
  for (let i = 0; i < 30; i++) pos.run(Number(tok.run(`0xst${i}`, now).lastInsertRowid), now - 7 * 86_400_000, now - 3_600_000);
  const md = buildReport(db, cfg).markdown;
  assert.ok(!md.includes("| stale_arm |"), "a 7 napja nyitott pozíció nem kerülhet a 24 órás riportba");
});

test("tárca-igény: az élő kar egyidejűleg nyitott pozícióinak csúcsa × élő méret", async () => {
  const { walletNeed, walletLine } = await import("../src/analysis/wallet.js");
  const { openDb } = await import("../src/db/index.js");
  const { loadConfig } = await import("../src/config.js");
  const cfg = loadConfig("config.yaml");
  const db = openDb(":memory:");
  for (let i = 1; i <= 7; i++) db.prepare("INSERT INTO tokens(id, chain, address, creator, launchpad, mechanics, discovered_at) VALUES (?,'base',?,'0xc','uniswap','v4',0)").run(i, `0x${i}`);
  let tid = 0;
  const stmt = db.prepare("INSERT INTO positions(token_id, chain, arm, exit_plan, window_sec, opened_at, entry_price_native, size_usd, size_native, tokens_bought, tokens_remaining, closed_at, close_reason) VALUES (?,?,?,?,?,?,1,1,0,1,1,?,?)");
  const ins = { run: (...a: unknown[]) => stmt.run(++tid, ...a) };
  const arm = cfg.live_entry.arm, w = cfg.evaluation.live_window_sec, plan = cfg.live_entry.exit_plan;
  ins.run("base", arm, plan, w, 1000, 5000, "x");     // 1000–5000
  ins.run("base", arm, plan, w, 2000, 3000, "x");     // átfed → 2
  ins.run("base", arm, plan, w, 2500, 4000, "x");     // átfed → 3 (2500–3000)
  ins.run("base", arm, plan, w, 6000, null, null);    // nyitott
  ins.run("base", arm, plan, w, 2600, 2700, "invalid_monitor_stall"); // érvénytelen → nem számít
  ins.run("robinhood", arm, plan, w, 2600, 2700, "x"); // másik lánc → nem számít
  ins.run("base", arm, "B", w, 2600, 2700, "x");      // másik terv → nem számít
  const r = walletNeed(db, cfg, 0, 2, 10_000);
  assert.equal(r.positions, 4); assert.equal(r.peakOpen, 3); assert.equal(r.openNow, 1);
  assert.ok(Math.abs(r.needUsd - 3 * 2.08) < 1e-9);
  assert.match(walletLine(db, cfg, 0, 2, 10_000), /még nincs mérve/);
  const put = db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)");
  put.run("wallet_base_eth", "0.005"); put.run("wallet_eth_usd", "3000"); put.run("wallet_at", "1");
  assert.match(walletLine(db, cfg, 0, 2, 10_000), /15\.00 USD → ✅ elég/);
  put.run("wallet_base_eth", "0.001");
  assert.match(walletLine(db, cfg, 0, 2, 10_000), /KEVÉS/);
  db.close();
});

test("telefonos állás: rövid sorok, élő kar Base-eredménye, jelöltek Σ-val", async () => {
  const { standingsCompact } = await import("../src/analysis/standings.js");
  const { openDb } = await import("../src/db/index.js");
  const { loadConfig } = await import("../src/config.js");
  const cfg = loadConfig("config.yaml");
  const db = openDb(":memory:");
  const w = cfg.evaluation.live_window_sec;
  let id = 0;
  const pos = (chain: string, arm: string, net: number) => {
    id++;
    db.prepare("INSERT INTO tokens(id, chain, address, creator, launchpad, mechanics, discovered_at) VALUES (?,?,?,'0xc','uniswap','v4',0)").run(id, chain, `0x${id}`);
    db.prepare("INSERT INTO positions(token_id, chain, arm, exit_plan, window_sec, opened_at, entry_price_native, size_usd, size_native, tokens_bought, tokens_remaining, phase, closed_at, close_reason, net_pnl_usd) VALUES (?,?,?,'live',?,?,1,1,0,1,0,'closed',?,'x',?)")
      .run(id, chain, arm, w, 2000, 3000, net);
  };
  for (let i = 0; i < 5; i++) pos("base", cfg.live_entry.arm, 1);
  pos("robinhood", cfg.live_entry.arm, -1);
  for (let i = 0; i < 3; i++) pos("base", "rule_v2", 2);
  for (let i = 0; i < 4; i++) pos("base", "random_control", -0.5);
  const txt = standingsCompact(db, 1000, cfg, 3_600_000 * 10);
  assert.match(txt, /Base: \+1\.00 · n5 · Σ\+5\.0/);
  assert.match(txt, /Össz: \+0\.67 · n6/);
  assert.match(txt, /v2 +\+2\.00·n3·Σ\+6\.0/);
  assert.match(txt, /Véletlen: −0\.50 \(n4\)/);
  for (const line of txt.split("\n")) assert.ok(line.length <= 34, `túl hosszú sor: ${line}`);
  db.close();
});

test("időarányos: aktív napok a kiesett időszak levonásával; USD/nap sor", async () => {
  const { activeDays, tempoCompact } = await import("../src/analysis/standings.js");
  const day = 86_400_000;
  const a = Date.parse("2026-10-01T21:27:44Z"), b = Date.parse("2026-10-02T06:09:50Z");
  assert.ok(Math.abs(activeDays(a - day, b + day) - (2 * day) / day) < 1e-9);   // a kiesett szakasz teljesen levonva
  assert.ok(Math.abs(activeDays(b, b + 2 * day) - 2) < 1e-9);                 // utána indult kar: nincs levonás
  const { openDb } = await import("../src/db/index.js");
  const { loadConfig } = await import("../src/config.js");
  const cfg = loadConfig("config.yaml");
  const db = openDb(":memory:");
  const now = Date.parse("2026-10-10T00:00:00Z"), start = now - 2 * day;
  for (let i = 1; i <= 4; i++) {
    db.prepare("INSERT INTO tokens(id, chain, address, creator, launchpad, mechanics, discovered_at) VALUES (?,'base',?,'0xc','uniswap','v4',0)").run(i, `0x${i}`);
    db.prepare("INSERT INTO positions(token_id, chain, arm, exit_plan, window_sec, opened_at, entry_price_native, size_usd, size_native, tokens_bought, tokens_remaining, phase, closed_at, close_reason, net_pnl_usd) VALUES (?,'base',?,'live',?,?,1,1,0,1,0,'closed',?,'x',3)")
      .run(i, cfg.live_entry.arm, cfg.evaluation.live_window_sec, start + i, start + i + 1000);
  }
  const txt = tempoCompact(db, start - 1, cfg, now);
  assert.match(txt, /v2_strict★ +\+6\.0 · +2p ·2\$:\+12/);   // 12 USD / 2 nap = +6/nap, 2 belépés/nap, élő 2 USD-vel +12
  for (const line of txt.split("\n")) assert.ok(line.length <= 36, `túl hosszú: ${line}`);
  db.close();
});
