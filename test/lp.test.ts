import { test } from "node:test";
import assert from "node:assert/strict";
import { largestPosition, classifyOwner, isBurn } from "../src/collector/lp.js";
import { baseUniLpArm } from "../src/decision/rules.js";
import type { ParamSnapshot } from "../src/collector/types.js";

const PM = "0x1111111111111111111111111111111111111111" as const;
const ME = "0x2222222222222222222222222222222222222222" as const;
const salt = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as `0x${string}`;

test("LP: legnagyobb nettó pozíció, kivett likviditás", () => {
  assert.equal(largestPosition([]), null);
  const p = largestPosition([{ sender: PM, salt: salt(7), delta: 100n }, { sender: ME, salt: salt(0), delta: 10n }]);
  assert.equal(p!.sender, PM); assert.equal(BigInt(p!.salt), 7n); assert.equal(p!.net, 100n);
  const gone = largestPosition([{ sender: PM, salt: salt(7), delta: 100n }, { sender: PM, salt: salt(7), delta: -100n }]);
  assert.equal(gone!.net, 0n); assert.equal(gone!.everAdded, true);
});

test("LP: tulajdonos-kategória", () => {
  assert.equal(isBurn("0x000000000000000000000000000000000000dead"), true);
  assert.equal(classifyOwner("0x000000000000000000000000000000000000dEaD", ME, false), "burned");
  assert.equal(classifyOwner("0x0000000000000000000000000000000000000000", ME, false), "burned");
  assert.equal(classifyOwner(ME, ME, false), "creator");
  assert.equal(classifyOwner(PM, ME, false), "eoa");
  assert.equal(classifyOwner(PM, null, true), "contract");
});

test("base_uni_lp karok", () => {
  const s = (lp: string, creator: string, prior: number) => ({ contract: { lp_owner: lp }, creator: { address: creator, prior_tokens: prior } }) as unknown as ParamSnapshot;
  assert.equal(baseUniLpArm("base", "uniswap", s("burned", ME, 3), "burned").enter, true);
  assert.equal(baseUniLpArm("base", "uniswap", s("creator", ME, 0), "burned").enter, false);
  assert.equal(baseUniLpArm("robinhood", "uniswap", s("burned", ME, 0), "burned").enter, false);
  assert.equal(baseUniLpArm("base", "uniswap", s("contract", ME, 0), "clean").enter, true);
  assert.equal(baseUniLpArm("base", "uniswap", s("burned", ME, 0), "clean").enter, true);
  assert.equal(baseUniLpArm("base", "uniswap", s("eoa", ME, 0), "clean").enter, false);
  assert.equal(baseUniLpArm("base", "uniswap", s("contract", ME, 2), "clean").enter, false);
  assert.equal(baseUniLpArm("base", "uniswap", s("contract", "unknown", 0), "clean").enter, false);
});

test("v4 virtuális ETH-tartalék és készítő-egyenleg belépéskor", async () => {
  const { v4NativeReserve } = await import("../src/collector/stats.js");
  const { creatorBalanceAtEntry } = await import("../src/decision/engine.js");
  // sqrtP = 1 (ár 1:1), L = 1e18 → 1 ETH mindkét irányban
  const Q96 = 2n ** 96n;
  assert.ok(Math.abs(v4NativeReserve(10n ** 18n, Q96, true)! - 1) < 1e-9);
  assert.ok(Math.abs(v4NativeReserve(10n ** 18n, Q96, false)! - 1) < 1e-9);
  // sqrtP = 2: ETH currency0 → L/2, currency1 → 2L
  assert.ok(Math.abs(v4NativeReserve(10n ** 18n, 2n * Q96, true)! - 0.5) < 1e-9);
  assert.ok(Math.abs(v4NativeReserve(10n ** 18n, 2n * Q96, false)! - 2) < 1e-9);
  assert.equal(v4NativeReserve(0n, Q96, true), null);
  const snap = (bal: unknown, supply: unknown) => ({ creator: { token_balance: bal }, contract: { total_supply: supply } }) as unknown as ParamSnapshot;
  assert.equal(creatorBalanceAtEntry(snap(50, 1000)), 50);
  assert.equal(creatorBalanceAtEntry(snap(5, 1000)), null);       // 0,5% → por, nem figyeljük
  assert.equal(creatorBalanceAtEntry(snap("unknown", 1000)), null);
});
