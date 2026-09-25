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
