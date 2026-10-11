import { test } from "node:test";
import assert from "node:assert/strict";
import { embeddedAddresses, operatorAddresses, looksLikeAddress, scamFlags } from "../src/filters/scamscan.js";

const OP = "e264430807f0b62688420ac17faad06b3ed40873";
test("scamscan: kódba égetett üzemeltető-cím felismerése, PUSH-adat átugrása, szöveg/infrastruktúra kiszűrése", () => {
  // PUSH1 0x73 (adatként, nem utasítás!) · PUSH20 <op> · PUSH20 0xff..ff · PUSH20 WETH · PUSH20 ASCII-szöveg
  const text = Buffer.from(" balanceERC20: trans").toString("hex");
  const code = "0x" + "6073" + "73" + OP + "73" + "f".repeat(40) + "73" + "4200000000000000000000000000000000000006" + "73" + text + "00";
  assert.deepEqual(embeddedAddresses(code), ["0x" + OP, "0x" + "f".repeat(40), "0x4200000000000000000000000000000000000006", "0x" + text]);
  assert.equal(looksLikeAddress("0x" + text), false);
  assert.equal(looksLikeAddress("0x00000000000000000000000000006f6c634300081c0033".slice(0, 42)), false);
  assert.deepEqual(operatorAddresses(code), ["0x" + OP]);
  assert.equal(looksLikeAddress("0x6f6c634300081c0033"), false);              // csonka metaadat a kód végén
  assert.equal(looksLikeAddress("0x5822122074bc05b6edb088c198299d39e338f71a"), false); // ipfs-hash a metaadatban
  assert.equal(looksLikeAddress("0x4200000000000000000000000000000000000028"), false); // SuperchainTokenBridge (rendszer)
});

test("scamscan: jelek – farm-router, kódban lévő router, kényszerített átutalás, tanult cím", () => {
  const base = { embedded: [] as string[], buys: 20, topRouter: "0xabc", topRouterShare: 0.9, topRouterValue0: 1, topRouterEmbedded: false, forced: 0 };
  assert.deepEqual(scamFlags(base), ["farm_router"]);
  assert.deepEqual(scamFlags({ ...base, topRouterValue0: 0.1 }), []);                       // értéket küldő vevők: nem farm
  assert.deepEqual(scamFlags({ ...base, buys: 3 }), []);                                    // kevés vétel: nem ítélünk
  assert.deepEqual(scamFlags({ ...base, topRouter: "0x6ff5693b99212da76ad316178a184ab56d299b43" }), []); // Universal Router
  assert.deepEqual(scamFlags({ ...base, topRouterValue0: 0, embedded: ["0x" + OP], topRouterEmbedded: true, forced: 2 }, new Set(["0x" + OP])),
    ["marked_operator", "embedded_operator", "router_in_code", "forced_transfer"]);
});
