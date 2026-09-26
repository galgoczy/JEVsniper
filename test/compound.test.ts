import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";
import { applyClose, computePositionUsd, effectiveGrowth, type CompoundState } from "../src/compound/index.js";

const cfg = loadConfig("config.yaml");
const s0: CompoundState = { deposit_usd: 30, growth_pool_usd: 0, reserve_usd: 0, working_capital_peak_usd: 30, position_usd: 1, updated_at: 0 };

test("kézi példa: 3 nyerő (+2, +3, +5) és 2 vesztes (−1, −0.8) → kassza 3, tartalék 7, betét 28.2", () => {
  let s = s0;
  for (const net of [2, -1, 3, -0.8, 5]) s = applyClose(s, net, 0.3);
  assert.ok(Math.abs(s.growth_pool_usd - 3.0) < 1e-9);      // 30% · 10
  assert.ok(Math.abs(s.reserve_usd - 7.0) < 1e-9);          // 70% · 10
  assert.ok(Math.abs(s.deposit_usd - 28.2) < 1e-9);         // veszteség a betétből
  assert.ok(Math.abs(s.working_capital_peak_usd - 31.2) < 1e-9);
  // méret: 1 + 3/15 = 1.2 USD
  assert.ok(Math.abs(computePositionUsd(s, cfg.risk, cfg.compound, true) - 1.2) < 1e-9);
});

test("veszteség sosem éri a tartalékot; a betét után a kassza fogy", () => {
  let s = { ...s0, deposit_usd: 0.5, growth_pool_usd: 2, reserve_usd: 5 };
  s = applyClose(s, -1.5, 0.3);
  assert.equal(s.deposit_usd, 0); assert.ok(Math.abs(s.growth_pool_usd - 1.0) < 1e-9); assert.equal(s.reserve_usd, 5);
});

test("visszaesés 30%-nál a kassza felezve a méretszámításban, új csúcsig", () => {
  let s = { ...s0, deposit_usd: 30, growth_pool_usd: 15, working_capital_peak_usd: 45 };
  assert.equal(effectiveGrowth(s, 30).inDrawdown, false);
  assert.ok(Math.abs(computePositionUsd(s, cfg.risk, cfg.compound, true) - 2.0) < 1e-9);   // 1 + 15/15
  s = applyClose(s, -14, 0.3);     // forgó tőke 45 → 31 (−31%)
  assert.equal(effectiveGrowth(s, 30).inDrawdown, true);
  assert.ok(Math.abs(computePositionUsd(s, cfg.risk, cfg.compound, true) - 1.5) < 1e-9);   // 1 + 7.5/15
  s = applyClose(s, 20, 0.3);      // új csúcs
  assert.equal(effectiveGrowth(s, 30).inDrawdown, false);
});

test("méret a plafonig; kapu zárva → alapméret; veszteségből nem nő", () => {
  const big = { ...s0, growth_pool_usd: 500, working_capital_peak_usd: 530 };
  assert.equal(computePositionUsd(big, cfg.risk, cfg.compound, true), cfg.risk.max_position_usd);
  assert.equal(computePositionUsd(big, cfg.risk, cfg.compound, false), cfg.risk.base_position_usd);
  const lossy = applyClose(s0, -5, 0.3);
  assert.equal(computePositionUsd(lossy, cfg.risk, cfg.compound, true), cfg.risk.base_position_usd);
});
