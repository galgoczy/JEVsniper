import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";
import { planAction, emergencyReason, checkIntervalSec, type PosState } from "../src/exit/plans.js";
import { shadowCost } from "../src/exit/costmodel.js";

const cfg = loadConfig("config.yaml");
const D = 86_400_000;
const base = (over: Partial<PosState> = {}): PosState => ({ exit_plan: "live", phase: "pre_tp1", entry_price: 1, peak_price: 1, tokens_bought: 100, tokens_remaining: 100, opened_at: 0, stages_done: 0, ...over });

test("élő terv kézzel: 1 USD, 100 token @1 → 2x: 50 el, 5x: 30 el, 20x: maradék 20 el", () => {
  let p = base();
  assert.equal(planAction(p, 1.9, 1000, cfg.exit_plan), null);
  const a1 = planAction(p, 2.0, 1000, cfg.exit_plan)!; assert.equal(a1.sellTokens, 50); assert.equal(a1.phase, "post_tp1");
  p = base({ phase: "post_tp1", tokens_remaining: 50, peak_price: 2 });
  assert.equal(planAction(p, 4.9, 1000, cfg.exit_plan), null);
  const a2 = planAction(p, 5.0, 1000, cfg.exit_plan)!; assert.equal(a2.sellTokens, 30); assert.equal(a2.phase, "moon_bag");
  p = base({ phase: "moon_bag", tokens_remaining: 20, peak_price: 5 });
  assert.equal(planAction(p, 12, 1000, cfg.exit_plan), null);
  const a3 = planAction(p, 20, 1000, cfg.exit_plan)!; assert.equal(a3.sellTokens, 20); assert.ok(a3.closeAll);
  // bevétel: 50·2 + 30·5 + 20·20 = 100 + 150 + 400 = 650 a 100-as bekerülésre → 6,5x
});

test("moon bag trailing -50% csak 5x után; post_tp1 fázisban nincs trailing (config)", () => {
  const post1 = base({ phase: "post_tp1", tokens_remaining: 50, peak_price: 4 });
  assert.equal(planAction(post1, 1.5, 1000, cfg.exit_plan), null);        // -62% a csúcstól, de még nincs 5x → nincs trailing
  const moon = base({ phase: "moon_bag", tokens_remaining: 20, peak_price: 10 });
  assert.equal(planAction(moon, 5.1, 1000, cfg.exit_plan), null);
  const t = planAction(moon, 5.0, 1000, cfg.exit_plan)!; assert.equal(t.reason, "trailing_-50%"); assert.ok(t.closeAll);
  const t40 = planAction({ ...moon, exit_plan: "trail40" }, 6.0, 1000, cfg.exit_plan)!; assert.equal(t40.reason, "trailing_-40%");
  assert.equal(planAction({ ...moon, exit_plan: "trail60" }, 6.0, 1000, cfg.exit_plan), null);
  assert.equal(planAction({ ...moon, exit_plan: "moon10" }, 10, 1000, cfg.exit_plan)!.reason, "moon_10x");
});

test("7 napos limit minden tervre; B és C tervek", () => {
  assert.equal(planAction(base({ phase: "moon_bag", tokens_remaining: 20 }), 3, 7 * D, cfg.exit_plan)!.reason, "time_limit_7d");
  let b = base({ exit_plan: "B" });
  assert.equal(planAction(b, 2.4, 1, cfg.exit_plan), null);
  const b1 = planAction(b, 2.5, 1, cfg.exit_plan)!; assert.equal(b1.sellTokens, 25); assert.equal(b1.reason, "B_stage1_2.5x");
  b = base({ exit_plan: "B", stages_done: 3, tokens_remaining: 25, phase: "post_tp2" });
  const b4 = planAction(b, 6, 1, cfg.exit_plan)!; assert.equal(b4.sellTokens, 25); assert.ok(b4.closeAll);
  const c1 = planAction(base({ exit_plan: "C" }), 2, 1, cfg.exit_plan)!; assert.equal(c1.sellTokens, 50); assert.equal(c1.phase, "post_tp1");
  const c = base({ exit_plan: "C", phase: "post_tp1", tokens_remaining: 50, peak_price: 4 });
  assert.equal(planAction(c, 2.7, 1, cfg.exit_plan), null);
  assert.equal(planAction(c, 2.6, 1, cfg.exit_plan)!.reason, "C_trailing_-35%");
});

test("vészkilépés: -40%, creator 20%, likviditás -30%, sell-sim, risk_off fázis szerint", () => {
  const p = base();
  const sig = { creatorSoldPct: null, liquidityDropPct: null, sellSimFailed: false, regime: "normal", scammerBigSell: false };
  assert.equal(emergencyReason(p, 0.61, sig, cfg.emergency, cfg.regime), null);
  assert.equal(emergencyReason(p, 0.60, sig, cfg.emergency, cfg.regime), "price_drop_-40%");
  assert.equal(emergencyReason(p, 1, { ...sig, creatorSoldPct: 20 }, cfg.emergency, cfg.regime), "creator_sold_20%");
  assert.equal(emergencyReason(p, 1, { ...sig, liquidityDropPct: 30 }, cfg.emergency, cfg.regime), "liquidity_drop_-30%");
  assert.equal(emergencyReason(p, 1, { ...sig, sellSimFailed: true }, cfg.emergency, cfg.regime), "sell_simulation_failed");
  assert.equal(emergencyReason(p, 1, { ...sig, regime: "risk_off" }, cfg.emergency, cfg.regime), "regime_risk_off");
  assert.equal(emergencyReason({ ...p, phase: "post_tp1" }, 1, { ...sig, regime: "risk_off" }, cfg.emergency, cfg.regime), null);
});

test("adaptív figyelés: 15 mp / 60 mp / 5 perc / moon bag 15 perc", () => {
  assert.equal(checkIntervalSec(base(), 60_000, cfg.monitoring), 15);
  assert.equal(checkIntervalSec(base(), 10 * 60_000, cfg.monitoring), 60);
  assert.equal(checkIntervalSec(base(), 2 * 3_600_000, cfg.monitoring), 300);
  assert.equal(checkIntervalSec(base({ phase: "moon_bag" }), 60_000, cfg.monitoring), 900);
});

test("árnyék-költségmodell: díj + csúszás a tartalékból + MEV + gas", () => {
  const c = shadowCost("robinhood", "buy", 1, { feePct: 2, liquidityNative: 99 }, cfg.cost_model);
  assert.equal(c.gasUsd, 0.025);
  assert.ok(Math.abs(c.feeNative - 0.02) < 1e-12);
  assert.ok(Math.abs(c.slippageNative - 0.01) < 1e-12);   // 1/(99+1)
  assert.ok(Math.abs(c.mevNative - 0.003) < 1e-12);
  assert.ok(Math.abs(c.netNative - 0.967) < 1e-12);
  const d = shadowCost("base", "sell", 1, { feePct: 1, liquidityNative: null }, cfg.cost_model);
  assert.ok(Math.abs(d.slippageNative - 0.02) < 1e-12);
});
