import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";
import { liveEntryRule, jevDirectArm, ruleScore, randomControlArm, type Labels } from "../src/decision/rules.js";
import { jevStateFromSnapshot } from "../src/decision/state.js";
import { riskBlock } from "../src/decision/risk.js";
import { openDb, ensureCompoundState } from "../src/db/index.js";
import { JevClient, JevPausedError } from "../src/jev/client.js";
import { regimeQuestions } from "../src/jev/questions.js";
import type { ParamSnapshot } from "../src/collector/types.js";

const cfg = loadConfig("config.yaml");
const good: Labels = { contract_risk: "clean", p_clean: 0.9, creator_profile: "first_timer", wallet_pattern: "organic", p_bad_wallet: 0.1, buyer_quality: 55,
  crowd_type: "degens", p_bad_crowd: 0.2, dev_behavior: "holding", trade_pattern: "organic_accumulation", narrative_fit: 50, copycat: "original", social_quality: 30,
  entry_timing: "early", p_tp1: 0.4, p_stop: 0.4, p_neither: 0.2 };
const snap = { buyers: { smart_money_count: 0 } } as unknown as ParamSnapshot;

test("élő szabály: jó címkék belépnek, rezsimfüggő küszöb", () => {
  assert.equal(liveEntryRule(good, snap, "normal", cfg.entry).enter, true);
  assert.equal(liveEntryRule(good, snap, "cold", cfg.entry).enter, false);   // 0.4 <= 0.45
  assert.equal(liveEntryRule(good, snap, "risk_off", cfg.entry).enter, false);
});

test("élő szabály: egy-egy feltétel sérülése kiejt, ok naplózva", () => {
  const cases: Array<[Partial<Labels>, string]> = [
    [{ contract_risk: "suspicious" }, "contract_risk"], [{ creator_profile: "serial_rugger" }, "serial_rugger"],
    [{ wallet_pattern: "bot_farm", p_bad_wallet: 0.7 }, "wallet_pattern"], [{ crowd_type: "insiders", p_bad_crowd: 0.6 }, "crowd"],
    [{ dev_behavior: "distributing" }, "dev="], [{ trade_pattern: "distribution" }, "trade_pattern"], [{ entry_timing: "late" }, "timing"], [{ buyer_quality: 30 }, "buyer_quality"],
  ];
  for (const [over, key] of cases) {
    const r = liveEntryRule({ ...good, ...over }, snap, "normal", cfg.entry);
    assert.equal(r.enter, false); assert.ok(r.reasons.some((x) => x.includes(key)), key);
  }
});

test("méretmodulátor 1,5× csak ha buyer_quality≥70, smart money≥3, P(tp1)>0,5", () => {
  const s3 = { buyers: { smart_money_count: 3 } } as unknown as ParamSnapshot;
  assert.equal(liveEntryRule({ ...good, buyer_quality: 75, p_tp1: 0.6 }, s3, "normal", cfg.entry).sizeMultiplier, 1.5);
  assert.equal(liveEntryRule({ ...good, buyer_quality: 75, p_tp1: 0.6 }, snap, "normal", cfg.entry).sizeMultiplier, 1);
});

test("árnyékkarok: jev_direct küszöb, rule_score tartomány, random_control determinisztikus ~20%", () => {
  assert.equal(jevDirectArm(good, 0.3).enter, true); assert.equal(jevDirectArm(good, 0.5).enter, false);
  const s = { holders: { count: 100, top10_pct_ex_creator: 30, fresh_wallet_ratio_top20: 0.2 }, dynamics: { unique_buyers_per_min: 5, buyer_acceleration: 1.5, buy_sell_ratio: 4 },
    buyers: { bot_ratio: 0.1, smart_money_count: 1, known_scammer_count: 0 }, creator: { token_share_pct: 2, sold_any: false, prior_graduated: 0 }, meta: { copycats_24h: 0 } } as unknown as ParamSnapshot;
  const v = ruleScore(s); assert.ok(v >= 60 && v <= 100, `rule_score=${v}`);
  let n = 0; for (let i = 0; i < 2000; i++) if (randomControlArm(`0x${i.toString(16).padStart(40, "0")}`, 0.2).enter) n++;
  assert.ok(n > 300 && n < 500, `random_control ${n}/2000`);
  assert.equal(randomControlArm("0xabc", 0.2).enter, randomControlArm("0xABC", 0.2).enter);
});

test("Jev-állapot tömör, technikai mezők nélkül", () => {
  const full = { meta_snapshot: { chain: "base", token: "0x1", window_sec: 60, taken_at: 1, block: 2, elapsed_sec: 60, eth_usd: 2750.123 }, contract: { launchpad: "clanker", mechanics: "v4_hook", bytecode_hash: "0xdeadbeef", known_template: true },
    creator: {}, holders: {}, buyers: {}, dynamics: { buys_per_min: 1.23456 }, meta: {}, social: {}, launchpad_ctx: {}, timing: {} } as unknown as ParamSnapshot;
  const st = JSON.stringify(jevStateFromSnapshot(full, { regime: "hot" }));
  assert.ok(!st.includes("deadbeef") && st.includes('"market_regime":"hot"') && st.includes("1.23"));
});

test("kockázati korlátok: max_open_positions, egy tokenbe egyszer, betét-plafon", () => {
  const db = openDb(":memory:");
  ensureCompoundState(db, 30, 1);
  db.prepare("INSERT INTO tokens(id, chain, address, creator, launchpad, mechanics, discovered_at) VALUES (1,'base','0x1','0xc','clanker','v4_hook',0)").run();
  const t = { id: 1, chain: "base", creator: "0xc" };
  const o = { jevPaused: false, regime: "normal", consecutiveFailed: 0 };
  assert.equal(riskBlock(db, cfg, t, o), null);
  assert.equal(riskBlock(db, cfg, t, { ...o, jevPaused: true }), "jev_paused");
  assert.equal(riskBlock(db, cfg, t, { ...o, regime: "risk_off" }), "regime_risk_off");
  const ins = db.prepare("INSERT INTO positions(token_id, chain, arm, exit_plan, window_sec, opened_at, entry_price_native, size_usd, size_native, tokens_bought, tokens_remaining) VALUES (1,'base','live',?,60,?,1,1,0,1,1)");
  ins.run("live", Date.now());
  assert.equal(riskBlock(db, cfg, t, o), "already_entered_token");
  db.prepare("INSERT INTO tokens(id, chain, address, creator, launchpad, mechanics, discovered_at) VALUES (2,'base','0x2','0xd','clanker','v4_hook',0)").run();
  assert.equal(riskBlock(db, cfg, { id: 2, chain: "base", creator: "0xd" }, o), null);
  for (let i = 0; i < 14; i++) ins.run(`p${i}`, Date.now() - 2 * 3_600_000);
  assert.equal(riskBlock(db, cfg, { id: 2, chain: "base", creator: "0xd" }, o), "max_open_positions");
  db.close();
});

test("Jev-hiba → szünet, hívás naplózva", async () => {
  const db = openDb(":memory:");
  const failing = (async () => new Response("{\"error\":\"boom\"}", { status: 500 })) as unknown as typeof fetch;
  const jev = new JevClient(db, { ...cfg, jev: { ...cfg.jev, max_retries: 0, pause_after_consecutive_errors: 2 } }, "ts_test_key_0000000000", failing);
  let paused = 0;
  for (let i = 0; i < 3; i++) { try { await jev.ask("x", regimeQuestions, { purpose: "verify" }); } catch (e) { if (e instanceof JevPausedError) paused++; } }
  assert.equal(jev.paused, true); assert.equal(paused, 1);
  assert.equal((db.prepare("SELECT COUNT(*) n FROM jev_calls WHERE ok = 0").get() as { n: number }).n, 2);
  db.close();
});
