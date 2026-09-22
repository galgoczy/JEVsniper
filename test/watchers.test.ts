import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeEventTopics, encodeAbiParameters, type Log, keccak256, toHex } from "viem";
import { sourcesFor } from "../src/watchers/sources.js";
import { ADDRESSES } from "../src/chains/addresses.js";
import { clankerV4TokenCreatedEvent } from "../src/abis/clankerV4.js";
import { ponsFactoryAbi } from "../src/abis/pons.js";
import { uniswapV4PoolManagerAbi } from "../src/abis/uniswap.js";

const TOKEN = "0x1111111111111111111111111111111111111111" as const;
const CREATOR = "0x2222222222222222222222222222222222222222" as const;
const CURVE = "0x3333333333333333333333333333333333333333" as const;
const base = (over: { address: `0x${string}` | undefined; topics: readonly unknown[]; data: `0x${string}` }): Log => ({
  blockHash: "0x00", blockNumber: 100n, logIndex: 0, transactionHash: "0xabc", transactionIndex: 0, removed: false, ...over,
} as unknown as Log);

test("PONS v2 TokenLaunched szignatúra egyezik a dokumentálttal és dekódolható", () => {
  const sig = keccak256(toHex("TokenLaunched(address,address,address,address,uint256,uint256)"));
  const topics = encodeEventTopics({ abi: ponsFactoryAbi, eventName: "TokenLaunched", args: { token: TOKEN, curve: CURVE, deployer: CREATOR } });
  assert.equal(topics[0], sig);
  const data = encodeAbiParameters([{ type: "address" }, { type: "uint256" }, { type: "uint256" }], ["0x0000000000000000000000000000000000000000", 1n, 5n * 10n ** 18n]);
  const src = sourcesFor("robinhood", {}).find((s) => s.key === "pons")!;
  const t = src.decode(base({ address: ADDRESSES.robinhood.ponsV2Factory, topics, data }))!;
  assert.equal(t.address, TOKEN); assert.equal(t.creator, CREATOR); assert.equal(t.pool, CURVE);
  assert.equal(t.mechanics, "bonding_curve"); assert.equal(t.launchpad, "pons");
});

test("Clanker v4 TokenCreated dekódolható", () => {
  const abi = [clankerV4TokenCreatedEvent];
  const topics = encodeEventTopics({ abi, eventName: "TokenCreated", args: { tokenAddress: TOKEN, tokenAdmin: CREATOR } });
  const nonIndexed = clankerV4TokenCreatedEvent.inputs.filter((i) => !i.indexed);
  const data = encodeAbiParameters(nonIndexed as never, [
    CREATOR, "img", "Test Token", "TST", "{}", "{}", -200000, "0x4444444444444444444444444444444444444444",
    "0x" + "ab".repeat(32), ADDRESSES.base.weth, "0x5555555555555555555555555555555555555555", "0x6666666666666666666666666666666666666666", 0n, [],
  ] as never);
  const src = sourcesFor("base", {}).find((s) => s.key === "clanker")!;
  const t = src.decode(base({ address: ADDRESSES.base.clankerV4Factory, topics, data }))!;
  assert.equal(t.address, TOKEN); assert.equal(t.symbol, "TST"); assert.equal(t.creator, CREATOR);
  assert.equal(t.mechanics, "v4_hook"); assert.equal(t.pairToken, ADDRESSES.base.weth);
});

test("Uniswap v4 Initialize: csak ETH/WETH pár; natív ETH (0x0) is felismerve", () => {
  const src = sourcesFor("robinhood", {}).find((s) => s.key === "uniswap_v4")!;
  const mk = (c0: `0x${string}`, c1: `0x${string}`) => {
    const topics = encodeEventTopics({ abi: uniswapV4PoolManagerAbi, eventName: "Initialize", args: { id: "0x" + "11".repeat(32) as `0x${string}`, currency0: c0, currency1: c1 } });
    const data = encodeAbiParameters([{ type: "uint24" }, { type: "int24" }, { type: "address" }, { type: "uint160" }, { type: "int24" }],
      [10000, 200, "0x0000000000000000000000000000000000000000", 1n << 96n, 0]);
    return base({ address: ADDRESSES.robinhood.uniswapV4PoolManager, topics, data });
  };
  const t = src.decode(mk("0x0000000000000000000000000000000000000000", TOKEN))!;
  assert.equal(t.address, TOKEN); assert.equal(t.mechanics, "v4");
  assert.equal(src.decode(mk(TOKEN, CREATOR)), null); // két nem-ETH token → nem érdekes
});

test("források láncenként", () => {
  assert.deepEqual(sourcesFor("base", {}).map((s) => s.key), ["clanker", "uniswap_v2", "uniswap_v3", "uniswap_v4"]);
  assert.deepEqual(sourcesFor("robinhood", {}).map((s) => s.key), ["clanker", "pons", "uniswap_v4"]);
  assert.deepEqual(sourcesFor("robinhood", { clanker: false }).map((s) => s.key), ["pons", "uniswap_v4"]);
});
