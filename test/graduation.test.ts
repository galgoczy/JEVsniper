import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";
import { openDb } from "../src/db/index.js";
import { GraduationTracker, gradHoldOk, GRAD_SNAPSHOT_WINDOW } from "../src/graduation/index.js";
import { launchpadArm } from "../src/decision/rules.js";
import type { ParamSnapshot } from "../src/collector/types.js";
import type { TokenRow } from "../src/collector/index.js";

const cfg = loadConfig("config.yaml");
const snap = (o: { price?: unknown; liq?: unknown; sold?: unknown; sellSim?: string } = {}) => ({
  meta_snapshot: { eth_usd: 3000, window_sec: GRAD_SNAPSHOT_WINDOW },
  contract: { sell_simulation: o.sellSim ?? "ok", sell_tax_pct: 0, dangerous_rights: [], known_template: true, liquidity_locked: true, liquidity_usd: 30_000, liquidity_native: "liq" in o ? o.liq : 10 },
  creator: { status: "unknown", sold_pct_of_initial: "sold" in o ? o.sold : 0 },
  holders: {}, buyers: { known_scammer_count: 0, unique_buyers: 5 }, social: {},
  dynamics: { price_native: "price" in o ? o.price : 2e-6 },
}) as unknown as ParamSnapshot;

test("graduáció +15 perc feltétel", () => {
  assert.equal(gradHoldOk(snap(), 1e-6).ok, true);
  assert.equal(gradHoldOk(snap({ price: 0.5e-6 }), 1e-6).ok, false);     // a graduációs ár alatt
  assert.equal(gradHoldOk(snap({ liq: 0 }), 1e-6).ok, false);           // kiürült
  assert.equal(gradHoldOk(snap({ sold: 60 }), 1e-6).ok, false);         // készítő dömpingelt
  assert.equal(gradHoldOk(snap({ sold: "unknown" }), 1e-6).ok, true);
});

test("graduáció: belépés graduáláskor a pool induló árán, +15 percnél szűrő és feltétel", async () => {
  const db = openDb(":memory:");
  const id = Number(db.prepare(`INSERT INTO tokens(chain, address, launchpad, mechanics, pool_address, pair_token, decimals, discovered_at, graduated_at)
    VALUES ('robinhood', '0x9999999999999999999999999999999999999999', 'pons', 'bonding_curve', '0x1111111111111111111111111111111111111111', '0x0000000000000000000000000000000000000000', 18, 0, 1)`).run().lastInsertRowid);
  const opened: Array<{ arm: string; price: number; liq: number | null }> = [];
  let next = snap();
  const g = new GraduationTracker({ db, cfg: { ...cfg, graduation: { enabled: true, delay_min: 15 } }, collect: async () => next, saveSnapshot: () => {},
    openShadow: (_t: TokenRow, arm, price, _eth, liq) => { opened.push({ arm, price, liq }); return 7; }, ethUsd: async () => 3000 });
  // token > ETH(0x0) → a token currency1; sqrtP = 1 → ár = 1/1 = 1 ETH/token (18 tizedes)
  await g.onGraduation(id, 2n ** 96n);
  assert.equal(opened[0]?.arm, "grad_at"); assert.ok(Math.abs(opened[0]!.price - 1) < 1e-12);
  g.stop();
  // +15 perc: ár a graduációs fölött → mindkét 15 perces kar
  next = snap({ price: 1.2 }); await g.delayed(id, 1);
  assert.deepEqual(opened.slice(1).map((o) => o.arm), ["grad_15_all", "grad_15_hold"]);
  // ár alatta → csak az alapvonal; eladás-szimuláció hibás → egyik sem
  opened.length = 0; next = snap({ price: 0.8 }); await g.delayed(id, 1);
  assert.deepEqual(opened.map((o) => o.arm), ["grad_15_all"]);
  opened.length = 0; next = snap({ price: 1.2, sellSim: "failed" }); await g.delayed(id, 1);
  assert.equal(opened.length, 0);
  // +30 mp: a friss pillanatkép valódi pool-árán, szűrő nélkül (hibás eladás-szimuláció mellett is – mint a grad_at)
  opened.length = 0; next = snap({ price: 1.7, sellSim: "failed" }); await g.delayed30(id);
  assert.deepEqual(opened.map((o) => o.arm), ["grad_30s"]); assert.ok(Math.abs(opened[0]!.price - 1.7) < 1e-12);
  opened.length = 0;
  // nem PONS token → semmi
  const other = Number(db.prepare("INSERT INTO tokens(chain, address, launchpad, discovered_at) VALUES ('base', '0x8888888888888888888888888888888888888888', 'clanker', 0)").run().lastInsertRowid);
  await g.onGraduation(other, 2n ** 96n); assert.equal(opened.length, 0); g.stop();
});

test("indítóplatform-karok", () => {
  assert.equal(launchpadArm("base", "clanker", "base/clanker").enter, true);
  assert.equal(launchpadArm("base", "uniswap", "base/clanker").enter, false);
  assert.equal(launchpadArm("robinhood", "pons", "robinhood/pons").enter, true);
});

test("figyelő: PONS-token későbbi v4 Initialize-a = graduáció → egyszer hívja a graduációs kezelőt", async () => {
  const { ChainWatcher } = await import("../src/watchers/index.js");
  const db = openDb(":memory:");
  const calls: Array<[number, bigint | null]> = [];
  const w = new ChainWatcher("robinhood", {} as never, db, { pollIntervalMs: 1000, maxBlockRange: 100, confirmations: 0, enabledSources: {}, onGraduation: (id, s) => { calls.push([id, s]); } });
  const tok = "0x9999999999999999999999999999999999999999" as const;
  const id = Number(db.prepare("INSERT INTO tokens(chain, address, launchpad, mechanics, discovered_at, discovered_block) VALUES ('robinhood', ?, 'pons', 'bonding_curve', 0, 100)").run(tok).lastInsertRowid);
  const init = { chain: "robinhood", address: tok, creator: null, launchpad: "uniswap", mechanics: "v4_hook", pool: `0x${"ab".repeat(32)}`, pairToken: "0x0000000000000000000000000000000000000000",
    name: null, symbol: null, blockNumber: 200n, txHash: null, initSqrtPriceX96: 123n,
    poolKey: { currency0: "0x0000000000000000000000000000000000000000", currency1: tok, fee: 0, tickSpacing: 200, hooks: "0xe5e702641ea86f4ae6cc3cdaed2b886f976be044" } };
  const up = (w as unknown as { upsertToken: (t: unknown) => Promise<void> }).upsertToken.bind(w);
  // idegen (nem PONS-hookos, 79% díjú) por-pool: nem graduáció, PoolKey sem
  await up({ ...init, blockNumber: 150n, initSqrtPriceX96: 9n, poolKey: { ...init.poolKey, fee: 790000, tickSpacing: 60, hooks: "0x0000000000000000000000000000000000000000" } });
  assert.deepEqual(calls, []);
  assert.deepEqual(db.prepare("SELECT graduated_at, pool_key_json FROM tokens WHERE id = ?").get(id), { graduated_at: null, pool_key_json: null });
  await up(init); await up(init);                                              // a második már nem graduáció
  assert.deepEqual(calls, [[id, 123n]]);
  const row = db.prepare("SELECT graduated_at, pool_key_json FROM tokens WHERE id = ?").get(id) as { graduated_at: number | null; pool_key_json: string | null };
  assert.ok(row.graduated_at && row.pool_key_json);
  await up({ ...init, blockNumber: 100n, address: "0x7777777777777777777777777777777777777777" }); // ismeretlen token → új uniswap token, nem graduáció
  assert.equal(calls.length, 1);
});

test("graduáció előtti kar: csak átlépésre, sávonként egyszer, átugrott sáv kimarad, csak natív quote", async () => {
  const { PreGradArms } = await import("../src/graduation/pregrad.js");
  const opened: string[] = [];
  const arms = new PreGradArms(async (id, arm) => { opened.push(`${id}:${arm}`); return 7; });
  const o = (tokenId: number, progressPct: number, nativeQuote = true) => arms.observe({ chain: "robinhood", tokenId, progressPct, price: 1e-9, liquidityNative: 1, nativeQuote });
  assert.deepEqual(await o(1, 30), []);                    // kiindulópont
  assert.deepEqual(await o(1, 55), ["pons_pregrad_50"]);   // átlépte az 50-et
  assert.deepEqual(await o(1, 60), []);                    // már belépett
  assert.deepEqual(await o(1, 85), ["pons_pregrad_80"]);   // átlépte a 80-at
  assert.deepEqual(await o(2, 40), []);
  assert.deepEqual(await o(2, 95), ["pons_pregrad_80"]);   // az 50-es sávot átugrotta → csak a 80-as
  assert.deepEqual(await o(3, 10), []);
  assert.deepEqual(await o(3, 100), []);                   // mindkét sávot átugrotta
  assert.deepEqual(await o(4, 60), []);                    // régóta a sávban ül (első megfigyelés) → nem belépő
  assert.deepEqual(await o(4, 65), []);                    // ...akkor sem, ha később mozdul a sávon belül
  assert.deepEqual(await o(4, 82), ["pons_pregrad_80"]);   // de a 80-at már látottan lépte át
  assert.deepEqual(await o(5, 20, false), []);
  assert.deepEqual(await o(5, 70, false), []);             // nem natív quote
  assert.deepEqual(opened, ["1:pons_pregrad_50", "1:pons_pregrad_80", "2:pons_pregrad_80", "4:pons_pregrad_80"]);
});
