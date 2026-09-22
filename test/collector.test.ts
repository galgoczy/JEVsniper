import { test } from "node:test";
import assert from "node:assert/strict";
import { holderStats, swapStats, priceFromSqrtX96, findDangerousSelectors, median } from "../src/collector/stats.js";

const E = 10n ** 18n;
const POOL = "0xpool", CREATOR = "0xcreator", ZERO = "0x0000000000000000000000000000000000000000";

test("holderStats: top1/top10, creator kizárva, airdrop-arány", () => {
  const tr = [
    { from: ZERO, to: POOL, value: 800n * E, block: 1n },
    { from: ZERO, to: CREATOR, value: 200n * E, block: 1n },
    { from: POOL, to: "0xa", value: 50n * E, block: 2n },
    { from: POOL, to: "0xb", value: 30n * E, block: 2n },
    { from: POOL, to: "0xc", value: 20n * E, block: 3n },
    { from: CREATOR, to: "0xd", value: 10n * E, block: 3n },  // airdrop a creatortól
    { from: CREATOR, to: POOL, value: 100n * E, block: 4n },  // creator elad
  ];
  const h = holderStats(tr, { pool: POOL, creator: CREATOR, totalSupply: 1000n * E });
  assert.equal(h.count, 4);
  assert.equal(h.top1_pct_ex_creator, 45.45); // 50/110
  assert.equal(h.top10_pct_ex_creator, 100);
  assert.equal(h.airdrop_received_ratio, 0.25);
  assert.equal(h.creator_share_pct, 9);          // 200-10-100 = 90 / 1000
  assert.equal(h.creator_sold_any, true);
  assert.equal(h.creator_sold_pct, 50);           // 100/200
  assert.equal(h.transfers_from_creator, 1);
});

test("swapStats: arányok, egyedi vevők, ár-változás, drawdown", () => {
  const t0 = 1_000_000;
  const sw = [
    { buyer: "0x1", isBuy: true, native: 0.1, tokens: 100, block: 1n, ts: t0 + 1000, priceNative: 0.001 },
    { buyer: "0x2", isBuy: true, native: 0.2, tokens: 100, block: 2n, ts: t0 + 20_000, priceNative: 0.002 },
    { buyer: "0x1", isBuy: true, native: 0.3, tokens: 100, block: 3n, ts: t0 + 50_000, priceNative: 0.004 },
    { buyer: "0x3", isBuy: false, native: 0.1, tokens: 50, block: 4n, ts: t0 + 55_000, priceNative: 0.003 },
  ];
  const s = swapStats(sw, { launchTs: t0, nowTs: t0 + 60_000, liquidityNative: 1, launchPriceNative: 0.001 });
  assert.equal(s.buys, 3); assert.equal(s.sells, 1);
  assert.equal(s.unique_buyers, 2); assert.equal(s.returning_buyers, 1);
  assert.equal(s.buys_per_min, 3);
  assert.equal(s.buy_sell_ratio, 3);
  assert.ok(Math.abs((s.net_inflow_native as number) - 0.5) < 1e-9);
  assert.equal(s.price_change_pct_since_launch, 200);
  assert.equal(s.peak_drawdown_pct, 25);
  assert.equal(s.median_buy_native, 0.2);
  assert.equal(s.largest_buy_pct_of_liquidity, 30);
  assert.equal(s.large_sells, 1);
});

test("swapStats üres → unknown mezők, nem dob hibát", () => {
  const s = swapStats([], { launchTs: 0, nowTs: 60_000, liquidityNative: null, launchPriceNative: null });
  assert.equal(s.buys, 0); assert.equal(s.price_native, "unknown"); assert.equal(s.avg_buy_native, "unknown");
});

test("priceFromSqrtX96: 1:1 ár mindkét irányban", () => {
  const one = 2n ** 96n;
  assert.ok(Math.abs(priceFromSqrtX96(one, true, 18) - 1) < 1e-12);
  assert.ok(Math.abs(priceFromSqrtX96(one, false, 18) - 1) < 1e-12);
  assert.ok(Math.abs(priceFromSqrtX96(one * 2n, true, 18) - 4) < 1e-9);
  assert.ok(Math.abs(priceFromSqrtX96(one, true, 6) - 1e-12) < 1e-24);
});

test("veszélyes szelektorok a bytecode-ban", () => {
  assert.deepEqual(findDangerousSelectors(("0x6040523463" + "40c10f19" + "14610000" + "63" + "8456cb59" + "00") as `0x${string}`), ["mint(address,uint256)", "pause()"]);
  assert.deepEqual(findDangerousSelectors("0x60806040"), []);
  assert.equal(median([3, 1, 2]), 2); assert.equal(median([]), null);
});
