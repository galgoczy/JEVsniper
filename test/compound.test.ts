import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";
import { applyClose, computePositionUsd, effectiveGrowth, type CompoundState } from "../src/compound/index.js";

const cfg = loadConfig("config.yaml");
// a képlet-példák 1 USD-s alapmérettel számolnak (a config.yaml alapja 2026-10-03 óta 2 USD)
const risk1 = { ...cfg.risk, base_position_usd: 1 };
const s0: CompoundState = { deposit_usd: 30, growth_pool_usd: 0, reserve_usd: 0, working_capital_peak_usd: 30, position_usd: 1, updated_at: 0 };

test("kézi példa: 3 nyerő (+2, +3, +5) és 2 vesztes (−1, −0.8) → kassza 3, tartalék 7, betét 28.2", () => {
  let s = s0;
  for (const net of [2, -1, 3, -0.8, 5]) s = applyClose(s, net, 0.3);
  assert.ok(Math.abs(s.growth_pool_usd - 3.0) < 1e-9);      // 30% · 10
  assert.ok(Math.abs(s.reserve_usd - 7.0) < 1e-9);          // 70% · 10
  assert.ok(Math.abs(s.deposit_usd - 28.2) < 1e-9);         // veszteség a betétből
  assert.ok(Math.abs(s.working_capital_peak_usd - 31.2) < 1e-9);
  // méret: 1 + 3/15 = 1.2 USD
  assert.ok(Math.abs(computePositionUsd(s, risk1, cfg.compound, true) - 1.2) < 1e-9);
});

test("veszteség sosem éri a tartalékot; a betét után a kassza fogy", () => {
  let s = { ...s0, deposit_usd: 0.5, growth_pool_usd: 2, reserve_usd: 5 };
  s = applyClose(s, -1.5, 0.3);
  assert.equal(s.deposit_usd, 0); assert.ok(Math.abs(s.growth_pool_usd - 1.0) < 1e-9); assert.equal(s.reserve_usd, 5);
});

test("visszaesés 30%-nál a kassza felezve a méretszámításban, új csúcsig", () => {
  let s = { ...s0, deposit_usd: 30, growth_pool_usd: 15, working_capital_peak_usd: 45 };
  assert.equal(effectiveGrowth(s, 30).inDrawdown, false);
  assert.ok(Math.abs(computePositionUsd(s, risk1, cfg.compound, true) - 2.0) < 1e-9);   // 1 + 15/15
  s = applyClose(s, -14, 0.3);     // forgó tőke 45 → 31 (−31%)
  assert.equal(effectiveGrowth(s, 30).inDrawdown, true);
  assert.ok(Math.abs(computePositionUsd(s, risk1, cfg.compound, true) - 1.5) < 1e-9);   // 1 + 7.5/15
  s = applyClose(s, 20, 0.3);      // új csúcs
  assert.equal(effectiveGrowth(s, 30).inDrawdown, false);
});

test("méret a plafonig; kapu zárva → alapméret; veszteségből nem nő", () => {
  const big = { ...s0, growth_pool_usd: 500, working_capital_peak_usd: 530 };
  assert.equal(computePositionUsd(big, { ...cfg.risk, max_position_usd: 10 }, cfg.compound, true), 10);   // plafonnal
  assert.ok(Math.abs(computePositionUsd(big, { ...cfg.risk, max_position_usd: null }, cfg.compound, true) - (cfg.risk.base_position_usd + 500 / cfg.risk.max_open_positions)) < 1e-9); // plafon nélkül
  assert.equal(computePositionUsd(big, cfg.risk, cfg.compound, false), cfg.risk.base_position_usd);
  const lossy = applyClose(s0, -5, 0.3);
  assert.equal(computePositionUsd(lossy, cfg.risk, cfg.compound, true), cfg.risk.base_position_usd);
});

test("BNB visszaforgatás: nyereség 30%-a a tőkéhez, veszteség 100%-ban; méret arányos, legalább 1 USD; 03:01 helyi idő", async () => {
  const { applyDay, MIN_POSITION_USD } = await import("../src/bnb/compound.js");
  const { isLocalTime, localDay } = await import("../src/compound/index.js");
  const s0 = { initial_capital_usd: 6, capital_usd: 6, reserve_usd: 0, position_usd: 1.5, last_recalc_at: 0 };
  const win = applyDay(s0, 4, 0.3, 1.5);                       // +4 USD nap → tőke 7,2; tartalék 2,8; méret 1,5 × 7,2/6 = 1,8
  assert.ok(Math.abs(win.capital_usd - 7.2) < 1e-9); assert.ok(Math.abs(win.reserve_usd - 2.8) < 1e-9); assert.ok(Math.abs(win.position_usd - 1.8) < 1e-9);
  const loss = applyDay(win, -3, 0.3, 1.5);                    // −3 USD nap → tőke 4,2 (100%); tartalék marad; méret 1,05
  assert.ok(Math.abs(loss.capital_usd - 4.2) < 1e-9); assert.ok(Math.abs(loss.reserve_usd - 2.8) < 1e-9); assert.ok(Math.abs(loss.position_usd - 1.05) < 1e-9);
  const floor = applyDay(loss, -4, 0.3, 1.5);                  // nagy veszteség → tőke 0,2; méret a padlón (1 USD)
  assert.equal(floor.position_usd, MIN_POSITION_USD);
  assert.equal(isLocalTime("03:01", "Europe/Budapest", new Date("2026-10-08T01:01:30Z")), true);   // nyári idő: UTC+2
  assert.equal(isLocalTime("03:01", "Europe/Budapest", new Date("2026-12-08T02:01:30Z")), true);   // téli idő: UTC+1
  assert.equal(isLocalTime("03:01", "Europe/Budapest", new Date("2026-10-08T03:01:30Z")), false);
  assert.equal(localDay("Europe/Budapest", new Date("2026-10-07T22:30:00Z")), "2026-10-08");
});
