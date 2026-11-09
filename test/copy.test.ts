import { test } from "node:test";
import assert from "node:assert/strict";
import type { PublicClient } from "viem";
import { loadConfig } from "../src/config.js";
import { openDb } from "../src/db/index.js";
import { v4IsBuy, v4TraderFromTransfers } from "../src/collector/stats.js";
import { scoreWallets } from "../src/copy/scoring.js";
import { CopyTracker } from "../src/copy/tracker.js";
import { ADDRESSES } from "../src/chains/addresses.js";
import type { TokenRow } from "../src/collector/index.js";

const cfg = loadConfig("config.yaml");
const PM = ADDRESSES.base.uniswapV4PoolManager!;
const W = "0x1111111111111111111111111111111111111111", W2 = "0x2222222222222222222222222222222222222222";

test("v4 irány: pozitív token-mennyiség = a kereskedő kapta = vétel (v4-core swapDelta)", () => {
  assert.equal(v4IsBuy(5n), true); assert.equal(v4IsBuy(-5n), false);
  const m = v4TraderFromTransfers([
    { from: PM, to: W, value: 1n, block: 1n, tx: "0xa" },   // vétel
    { from: W2, to: PM, value: 1n, block: 1n, tx: "0xb" },  // eladás
  ], PM);
  assert.equal(m.get("0xa")?.buyer, W); assert.equal(m.get("0xb")?.seller, W2);
});

test("tárcapontozás: csak lezárt kör számít; smart / unskilled / kevés adat", () => {
  const db = openDb(":memory:");
  const tok = db.prepare("INSERT INTO tokens(chain, address, discovered_at) VALUES ('base', ?, 0)");
  const tr = db.prepare("INSERT INTO wallet_trades(chain, token_id, wallet, is_buy, native, tokens, block, at, tx_hash) VALUES ('base', ?, ?, ?, ?, ?, 1, ?, ?)");
  for (let i = 0; i < 6; i++) {
    const id = Number(tok.run(`0x${i}`).lastInsertRowid);
    tr.run(id, "smartw", 1, 0.01, 100, 1000, `b${i}`); tr.run(id, "smartw", 0, i < 4 ? 0.02 : 0.005, 95, 2000, `s${i}`);   // 4 nyerő, 2 vesztes, összesen +
    tr.run(id, "badw", 1, 0.01, 100, 1000, `x${i}`); tr.run(id, "badw", 0, 0.004, 100, 2000, `y${i}`);                    // mind vesztes
    tr.run(id, "holder", 1, 0.01, 100, 1000, `h${i}`);                                                                     // nem adott el → nincs lezárt kör
  }
  const s = scoreWallets(db, "base", { minClosed: 5, minWinRate: 0.5 });
  assert.equal(s.get("smartw")?.cls, "smart"); assert.equal(s.get("smartw")?.closed, 6);
  assert.equal(s.get("badw")?.cls, "unskilled");
  assert.equal(s.get("holder"), undefined);
  assert.equal(scoreWallets(db, "base", { minClosed: 5, minWinRate: 0.5, untilMs: 1500 }).size, 0); // az eladások előtti állapot: nincs lezárt kör
});

test("copy tracker: v4 vétel egy smart tárcától → copy_smart árnyékpozíció", async () => {
  const db = openDb(":memory:");
  const token = "0x9999999999999999999999999999999999999999";
  const poolId = `0x${"ab".repeat(32)}` as `0x${string}`;
  const tid = Number(db.prepare(`INSERT INTO tokens(chain, address, launchpad, mechanics, pool_address, pair_token, pool_key_json, decimals, discovered_at)
    VALUES ('base', ?, 'uniswap', 'v4', ?, '0x0000000000000000000000000000000000000000', '{}', 18, ?)`).run(token, poolId, Date.now()).lastInsertRowid);
  db.prepare("INSERT INTO decisions(token_id, arm, window_sec, regime, decided_at, enter, reason) VALUES (?, 'random_control', 60, 'normal', ?, 0, 'x')").run(tid, Date.now());
  // a W tárca múltja: 5 nyerő lezárt kör más tokenekben
  for (let i = 0; i < 5; i++) {
    const id = Number(db.prepare("INSERT INTO tokens(chain, address, discovered_at) VALUES ('base', ?, 0)").run(`0xold${i}`).lastInsertRowid);
    db.prepare("INSERT INTO wallet_trades(chain, token_id, wallet, is_buy, native, tokens, block, at, tx_hash) VALUES ('base', ?, ?, 1, 0.01, 100, 1, 1, ?)").run(id, W.toLowerCase(), `ob${i}`);
    db.prepare("INSERT INTO wallet_trades(chain, token_id, wallet, is_buy, native, tokens, block, at, tx_hash) VALUES ('base', ?, ?, 0, 0.03, 100, 2, 2, ?)").run(id, W.toLowerCase(), `os${i}`);
  }
  const Q96 = 2n ** 96n;
  const client = {
    getBlockNumber: async () => 1000n,
    getLogs: async (a: { args?: Record<string, unknown>; event?: { name?: string } }) => {
      if (a.event?.name === "Swap") return [{ args: { id: poolId, amount0: -(10n ** 16n), amount1: 10n ** 21n, sqrtPriceX96: Q96, liquidity: 10n ** 18n }, blockNumber: 999n, transactionHash: "0xt1" }];
      if (a.event?.name === "Transfer" && a.args?.from) return [{ args: { from: PM, to: W, value: 10n ** 21n }, blockNumber: 999n, transactionHash: "0xt1" }];
      return [];
    },
  } as unknown as PublicClient;
  const opened: Array<{ arm: string; price: number }> = [];
  const ct = new CopyTracker({ db, cfg, chain: "base", client, ethUsd: async () => 3000,
    openShadow: (_t: TokenRow, arm, price) => { opened.push({ arm, price }); return 7; } });
  await ct.tick();
  const saved = db.prepare("SELECT wallet, is_buy, native FROM wallet_trades WHERE tx_hash = '0xt1'").get() as { wallet: string; is_buy: number; native: number };
  assert.equal(saved.wallet, W.toLowerCase()); assert.equal(saved.is_buy, 1); assert.ok(Math.abs(saved.native - 0.01) < 1e-12);
  assert.deepEqual(opened.map((o) => o.arm), ["copy_smart"]);
  assert.ok(opened[0]!.price > 0);
});
