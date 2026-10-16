import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeFunctionData, decodeAbiParameters, parseAbiParameters } from "viem";
import { curveBuyQuote, curveSellQuote, encodeV4SwapCalldata } from "../src/exec/routes.js";
import { universalRouterAbi } from "../src/abis/uniswapV4.js";

const E = 10n ** 18n;
const state = { quoteReserve: 10n * E, tokenReserve: 1_000_000n * E, reservedTokens: 200_000n * E, feeBps: 100n, creatorTaxBps: 100n, snipeBps: 0n };

test("curve vétel: díjak levonva, kimenet a konstans szorzat szerint", () => {
  const q = curveBuyQuote(state, 1n * E);
  assert.equal(q.feeWei, E / 100n); assert.equal(q.taxWei, E / 100n);
  // net 0.98 ETH: out = 0.98 * 1e6 / (10 + 0.98) ≈ 89253 token
  const out = Number(q.amountOut) / 1e18;
  assert.ok(out > 89_000 && out < 89_500, `out=${out}`);
});

test("curve vétel snipe-adóval kisebb kimenet; curve vége: max. az eladható készlet", () => {
  const a = curveBuyQuote(state, E), b = curveBuyQuote({ ...state, snipeBps: 5000n }, E);
  assert.ok(b.amountOut < (a.amountOut * 6n) / 10n && b.amountOut > (a.amountOut * 4n) / 10n);
  const c = curveBuyQuote({ ...state, tokenReserve: 200_001n * E }, 1000n * E);
  assert.equal(c.amountOut, 1n * E);
});

test("curve eladás: bruttó a képlet szerint, nettó díj+adó nélkül", () => {
  const q = curveSellQuote(state, 100_000n * E);
  // gross = 1e5 * 10 / (1e6 + 1e5) = 0.90909 ETH; net = 0.98 * gross
  const net = Number(q.amountOut) / 1e18;
  assert.ok(Math.abs(net - 0.909090909 * 0.98) < 1e-6, `net=${net}`);
});

test("v4 Universal Router calldata: execute(commands=[V4_SWAP, SWEEP], 2 input, deadline)", () => {
  const poolKey = { currency0: "0x0000000000000000000000000000000000000000", currency1: "0x1111111111111111111111111111111111111111", fee: 10000, tickSpacing: 200, hooks: "0x2222222222222222222222222222222222222222" } as const;
  const data = encodeV4SwapCalldata({ poolKey, zeroForOne: true, amountIn: 5n, minOut: 3n, inputCurrency: poolKey.currency0, outputCurrency: poolKey.currency1, recipient: "0x3333333333333333333333333333333333333333", deadline: 99n });
  const d = decodeFunctionData({ abi: universalRouterAbi, data });
  assert.equal(d.functionName, "execute");
  const [commands, inputs, deadline] = d.args;
  assert.equal(commands, "0x1004"); assert.equal(inputs.length, 2); assert.equal(deadline, 99n);
  const [actions, params] = decodeAbiParameters(parseAbiParameters("bytes actions, bytes[] params"), inputs[0]);
  assert.equal(actions, "0x060c0f"); assert.equal(params.length, 3);
  const [settleCur, settleMax] = decodeAbiParameters(parseAbiParameters("address, uint256"), params[1]!);
  assert.equal(settleCur, poolKey.currency0); assert.equal(settleMax, 5n);
  const [takeCur, takeMin] = decodeAbiParameters(parseAbiParameters("address, uint256"), params[2]!);
  assert.equal(takeCur, poolKey.currency1); assert.equal(takeMin, 3n);
});
