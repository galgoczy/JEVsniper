import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeEventTopics, encodeAbiParameters, getAbiItem, type AbiEvent } from "viem";
import { openDb } from "../src/db/index.js";
import { BnbRecorder } from "../src/bnb/recorder.js";
import { fourMemeTokenManager2Abi } from "../src/abis/fourmeme.js";

const enc = (name: string, args: Record<string, unknown>) => {
  const ev = getAbiItem({ abi: fourMemeTokenManager2Abi, name: name as never }) as unknown as AbiEvent;
  const topics = encodeEventTopics({ abi: [ev], eventName: ev.name } as never) as `0x${string}`[];
  const data = encodeAbiParameters(ev.inputs, ev.inputs.map((i) => args[i.name!]) as never);
  return { data, topics };
};
const TOK = "0x00000000000000000000000000000000000000aa", ME = "0x00000000000000000000000000000000000000bb";

test("BNB felvevő: indítás, vétel, eladás, graduáció mentése; dokumentálatlan esemény kihagyva; ismétlés nem duplikál", () => {
  const db = openDb(":memory:");
  const rec = new BnbRecorder({ db, client: {} as never });
  const L = (e: { data: `0x${string}`; topics: `0x${string}`[] }, block: bigint, i: number) => ({ ...e, blockNumber: block, transactionHash: `0x${"1".repeat(63)}${i}` as `0x${string}`, logIndex: i });
  const logs = [
    L(enc("TokenCreate", { creator: ME, token: TOK, requestId: 7n, name: "Teszt", symbol: "TST", totalSupply: 10n ** 27n, launchTime: 1_790_000_000n, launchFee: 0n }), 100n, 1),
    L(enc("TokenPurchase", { token: TOK, account: ME, price: 5n * 10n ** 9n, amount: 10n ** 24n, cost: 10n ** 17n, fee: 10n ** 15n, offers: 8n * 10n ** 26n, funds: 10n ** 17n }), 101n, 2),
    L(enc("TokenSale", { token: TOK, account: ME, price: 4n * 10n ** 9n, amount: 10n ** 23n, cost: 10n ** 16n, fee: 10n ** 14n, offers: 8n * 10n ** 26n, funds: 9n * 10n ** 16n }), 102n, 3),
    L(enc("TradeStop", { token: TOK }), 103n, 4),
    L(enc("LiquidityAdded", { base: TOK, offers: 2n * 10n ** 26n, quote: "0x0000000000000000000000000000000000000000", funds: 18n * 10n ** 18n }), 103n, 5),
    { data: "0x01" as `0x${string}`, topics: ["0x48063b1239b68b5d50123408787a6df1f644d9160f0e5f702fefddb9a855954d"] as `0x${string}`[], blockNumber: 101n, transactionHash: `0x${"2".repeat(64)}` as `0x${string}`, logIndex: 9 },
  ];
  rec.ingest(logs, 110n, 1_000_000);
  rec.ingest(logs, 110n, 1_000_000); // ismételt feldolgozás (átfedő lekérés) → nincs duplikátum
  const tok = db.prepare("SELECT * FROM bnb_tokens").all() as Array<Record<string, unknown>>;
  assert.equal(tok.length, 1); assert.equal(tok[0]!.symbol, "TST"); assert.equal(tok[0]!.creator, ME);
  const tr = db.prepare("SELECT side, price, funds, block, at FROM bnb_trades ORDER BY block").all() as Array<Record<string, unknown>>;
  assert.deepEqual(tr.map((r) => r.side), ["buy", "sell"]);
  assert.equal(tr[0]!.price, (5n * 10n ** 9n).toString());
  assert.equal(tr[0]!.at, 1_000_000 - Math.round(9 * 0.45 * 1000)); // 9 blokkal a fej előtt
  const gr = db.prepare("SELECT kind, quote, funds FROM bnb_grads ORDER BY kind").all() as Array<Record<string, unknown>>;
  assert.deepEqual(gr.map((r) => r.kind), ["liquidity_added", "trade_stop"]);
  assert.equal(gr[0]!.funds, (18n * 10n ** 18n).toString());
  assert.deepEqual(rec.stats.tokens + rec.stats.trades + rec.stats.grads, 4);
  db.close();
});

test("PancakeSwap felvevő: üres héj nem indítás; az első likviditás az indítás; vétel/eladás; pillanatképek; 24 órás kimenet", async () => {
  const { PancakeRecorder } = await import("../src/bnb/pancake.js");
  const { BNB } = await import("../src/bnb/addresses.js");
  const { encodeEventTopics, encodeAbiParameters, parseAbi } = await import("viem");
  const db = openDb(":memory:");
  let now = 1_000_000_000;
  const TOKEN = "0x00000000000000000000000000000000000000aa", PAIR = "0x00000000000000000000000000000000000000bb", SHELL = "0x00000000000000000000000000000000000000dd", OTHER = "0x00000000000000000000000000000000000000cc";
  const fac = parseAbi(["event PairCreated(address indexed token0, address indexed token1, address pair, uint256 allPairsLength)"]);
  const pairAbi = parseAbi(["event Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)", "event Sync(uint112 reserve0, uint112 reserve1)"]);
  const mk = (abi: readonly unknown[], name: string, args: Record<string, unknown>, address: string, block: bigint, i: number) => {
    const ev = (abi as Array<{ name: string; inputs: Array<{ name: string; indexed?: boolean; type: string }> }>).find((e) => e.name === name)!;
    const topics = encodeEventTopics({ abi: [ev], eventName: name, args } as never) as `0x${string}`[];
    const data = encodeAbiParameters(ev.inputs.filter((x) => !x.indexed) as never, ev.inputs.filter((x) => !x.indexed).map((x) => args[x.name]) as never);
    return { address, topics, data, blockNumber: block, transactionHash: `0x${String(i).padStart(64, "0")}`, logIndex: i } as never;
  };
  const E = 10n ** 18n;
  let reserves: Record<string, [bigint, bigint]> = { [PAIR]: [0n, 0n], [SHELL]: [0n, 0n] };
  const pairLogs = [mk(pairAbi, "Sync", { reserve0: 1000n * E, reserve1: 10n * E }, PAIR, 105n, 3),   // likviditás: 10 WBNB (token1)
    mk(pairAbi, "Sync", { reserve0: 900n * E, reserve1: 11n * E }, PAIR, 110n, 4), mk(pairAbi, "Swap", { sender: OTHER, amount0In: 0n, amount1In: E, amount0Out: 100n * E, amount1Out: 0n, to: OTHER }, PAIR, 110n, 5)];
  const client = {
    getTransaction: async () => ({ from: "0x00000000000000000000000000000000000000c1", to: "0x10ed43c718714eb63d5aa57b78b54704e256024e" }),
    multicall: async (q: { contracts: Array<{ address: string }> }) => q.contracts.map((x) => ({ status: "success", result: [...(reserves[x.address.toLowerCase()] ?? [0n, 0n]), 0] })),
    getLogs: async (q: { address: string; fromBlock: bigint; toBlock: bigint }) => (String(q.address).toLowerCase() === PAIR ? pairLogs.filter((l: { blockNumber: bigint }) => l.blockNumber >= q.fromBlock && l.blockNumber <= q.toBlock) : []),
  } as never;
  const rec = new PancakeRecorder({ db, client, now: () => now });
  await rec.onPairsCreated([mk(fac, "PairCreated", { token0: TOKEN, token1: BNB.wbnb, pair: PAIR, allPairsLength: 1n }, BNB.pancakeV2Factory, 100n, 1),
    mk(fac, "PairCreated", { token0: TOKEN, token1: BNB.wbnb, pair: SHELL, allPairsLength: 2n }, BNB.pancakeV2Factory, 100n, 2),
    mk(fac, "PairCreated", { token0: TOKEN, token1: OTHER, pair: OTHER, allPairsLength: 3n }, BNB.pancakeV2Factory, 100n, 6)], 100n, now);
  assert.equal(rec.stats.shells, 2);                                                       // csak a WBNB-párok
  await rec.checkShells(102n, now);                                                        // még üresek → nincs indítás
  assert.equal((db.prepare("SELECT count(*) n FROM bnb_pairs").get() as { n: number }).n, 0);
  reserves = { [PAIR]: [900n * E, 11n * E], [SHELL]: [0n, 0n] };
  await rec.checkShells(110n, now);                                                        // PAIR-ba likviditás került
  const p = db.prepare("SELECT * FROM bnb_pairs").get() as Record<string, unknown>;
  assert.equal(p.pair, PAIR); assert.equal(p.created_block, 105); assert.equal(p.pair_created_block, 100); assert.equal(p.creator, "0x00000000000000000000000000000000000000c1");
  assert.equal(rec.stats.waiting, 1);                                                      // a SHELL még vár
  now += 61_000; rec.flush();
  const s60 = db.prepare("SELECT * FROM bnb_pair_snapshots WHERE window_sec = 60").get() as Record<string, number>;
  assert.equal(s60.buys, 1); assert.equal(s60.unique_buyers, 1); assert.ok(Math.abs(s60.price - 11 / 900) < 1e-12); assert.ok(Math.abs(s60.liq_bnb - 11) < 1e-9);
  rec.ingestPairLogs([mk(pairAbi, "Sync", { reserve0: 1100n * E, reserve1: 6n * E }, PAIR, 300n, 7), mk(pairAbi, "Swap", { sender: OTHER, amount0In: 200n * E, amount1In: 0n, amount0Out: 0n, amount1Out: 5n * E, to: OTHER }, PAIR, 300n, 8)], 300n, now);
  assert.equal((db.prepare("SELECT count(*) n FROM bnb_pair_trades WHERE side = 'sell'").get() as { n: number }).n, 1);
  now += 25 * 3600_000; rec.flush();
  const o = db.prepare("SELECT * FROM bnb_pair_outcomes").get() as Record<string, number>;
  assert.ok(o.min_x < 0.5 && o.min_x > 0.4, `min_x ${o.min_x}`); assert.ok(Math.abs(o.min_liq_bnb - 6) < 1e-9); assert.ok(o.done_at > 0);
  assert.equal(rec.stats.tracked, 0);
  await rec.checkShells(400n, now); assert.equal(rec.stats.waiting, 0);                    // 6 óránál régebbi héj kikerül
  db.close();
});

test("BNB árnyék: +60 mp és bálna jelzés, eladhatósági próba (honeypot kiszűrve), tp2_sl40 / C kiszállás, kiürülés = 0", async () => {
  const { BnbShadow } = await import("../src/bnb/shadow.js");
  const db = openDb(":memory:");
  let now = 1_790_000_000_000; const T0 = now;
  const honeypot = new Set<string>();
  const client = {
    readContract: async () => 10n ** 21n,
    call: async (a: { to: string }) => { if (honeypot.has(a.to.toLowerCase())) throw new Error("revert"); return { data: "0x" }; },
  } as never;
  const sh = new BnbShadow({ db, client, bnbUsd: () => 500, sizeUsd: () => 1, now: () => now });
  const P1 = "0x00000000000000000000000000000000000000a1", T1 = "0x00000000000000000000000000000000000000b1";
  const P2 = "0x00000000000000000000000000000000000000a2", T2 = "0x00000000000000000000000000000000000000b2";
  const BUYER = "0x00000000000000000000000000000000000000c1";
  honeypot.add(T2);
  const ev = (pair: string, token: string, at: number, price: number, extra: Record<string, unknown> = {}) => sh.onEvent({ pair, token, createdAt: T0, at, kind: "trade", side: "buy", bnb: 0.1, to: BUYER, price, liq: 10, ...extra } as never);
  ev(P1, T1, T0 + 5_000, 1); ev(P2, T2, T0 + 5_000, 1);
  now = T0 + 30_000; await sh.step();
  assert.equal((db.prepare("SELECT count(*) n FROM bnb_shadow_positions").get() as { n: number }).n, 0);           // még nincs 60 mp
  now = T0 + 61_000; await sh.step(); await sh.step();
  assert.equal((db.prepare("SELECT count(*) n FROM bnb_shadow_positions WHERE arm = 'bnb_all60'").get() as { n: number }).n, 3); // P1, 3 terv
  assert.equal((db.prepare("SELECT reason FROM bnb_shadow_skips WHERE pair = ?").get(P2) as { reason: string }).reason, "honeypot");
  // bálna-vétel P1-en → második kar; ugyanebben a körben előtte 0,7 volt (a bálna-ár 1,2 −40%-a alatt, a +60s-belépés stopja fölött) – ez nem válthat ki stopot
  ev(P1, T1, T0 + 69_000, 0.7, { side: "sell" }); ev(P1, T1, T0 + 70_000, 1.2, { bnb: 2 });
  now = T0 + 72_000; await sh.step(); await sh.step();
  assert.equal((db.prepare("SELECT count(*) n FROM bnb_shadow_positions WHERE arm = 'bnb_whale'").get() as { n: number }).n, 3);
  assert.equal((db.prepare("SELECT count(*) n FROM bnb_shadow_positions WHERE arm = 'bnb_whale' AND closed_at IS NOT NULL").get() as { n: number }).n, 0); // nem zárt azonnal
  // ár a belépés (1) 2,1-szerese → tp2_sl40 zár, C fele elad; az aktuális (kör végi) ár 2,0
  ev(P1, T1, T0 + 80_000, 2.1); ev(P1, T1, T0 + 81_000, 2.0, { side: "sell" });
  now = T0 + 82_000; await sh.step();
  const tp = db.prepare("SELECT close_reason, net_usd FROM bnb_shadow_positions WHERE arm = 'bnb_all60' AND plan = 'tp2_sl40'").get() as { close_reason: string; net_usd: number };
  assert.equal(tp.close_reason, "tp_2x"); assert.ok(tp.net_usd > 0.9 && tp.net_usd < 1.0, `net ${tp.net_usd}`); // 2× a díjakkal és gázzal
  const c = db.prepare("SELECT phase, closed_at FROM bnb_shadow_positions WHERE arm = 'bnb_all60' AND plan = 'C'").get() as { phase: string; closed_at: number | null };
  assert.equal(c.phase, "post_tp1"); assert.equal(c.closed_at, null);
  // kiürülés → a maradék 0
  ev(P1, T1, T0 + 90_000, 0.01, { side: "sell", liq: 0.01 });
  now = T0 + 92_000; await sh.step();
  const open = (db.prepare("SELECT count(*) n FROM bnb_shadow_positions WHERE closed_at IS NULL").get() as { n: number }).n;
  assert.equal(open, 0);
  assert.equal((db.prepare("SELECT close_reason FROM bnb_shadow_positions WHERE arm = 'bnb_all60' AND plan = 'C'").get() as { close_reason: string }).close_reason, "drained");
  db.close();
});

test("BSC adó-mérés nyugtából: 5% vételi, 10% eladási adó; aggregátor-továbbküldés nem mérhető", async () => {
  const { taxFromReceipt, taxedNet } = await import("../src/bnb/tax.js");
  const { encodeEventTopics, encodeAbiParameters, parseAbi } = await import("viem");
  const abi = parseAbi(["event Transfer(address indexed from, address indexed to, uint256 value)", "event Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)"]);
  const PAIR = "0x00000000000000000000000000000000000000a1", TOKEN = "0x00000000000000000000000000000000000000b1", USER = "0x00000000000000000000000000000000000000c1", ROUTER = "0x00000000000000000000000000000000000000d1";
  const tr = (from: string, to: string, v: bigint) => ({ address: TOKEN, topics: encodeEventTopics({ abi, eventName: "Transfer", args: { from: from as `0x${string}`, to: to as `0x${string}` } }) as `0x${string}`[], data: encodeAbiParameters([{ type: "uint256" }], [v]) });
  const sw = (a0in: bigint, a1in: bigint, a0out: bigint, a1out: bigint, to: string) => ({ address: PAIR, topics: encodeEventTopics({ abi, eventName: "Swap", args: { sender: ROUTER as `0x${string}`, to: to as `0x${string}` } }) as `0x${string}`[], data: encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }], [a0in, a1in, a0out, a1out]) });
  // WBNB = token1 (wbnbIs0 = false) → a token oldala a 0-s
  const buy = [tr(PAIR, USER, 950n), tr(PAIR, TOKEN, 50n), sw(0n, 10n, 1000n, 0n, USER)];
  assert.ok(Math.abs(taxFromReceipt(buy, PAIR, TOKEN, false, "buy")! - 0.05) < 1e-9);
  const sell = [tr(USER, TOKEN, 100n), tr(USER, PAIR, 900n), sw(900n, 0n, 0n, 9n, ROUTER)];
  assert.ok(Math.abs(taxFromReceipt(sell, PAIR, TOKEN, false, "sell")! - 0.1) < 1e-9);
  const agg = [tr(PAIR, ROUTER, 1000n), tr(ROUTER, USER, 1000n), sw(0n, 10n, 1000n, 0n, ROUTER)];
  assert.equal(taxFromReceipt(agg, PAIR, TOKEN, false, "buy"), null);
  // korrekció: 1 USD → 2,0 USD kapott (net +1 − gáz), 5%/10% adóval a kapott 0,855-szöröse
  const n = taxedNet(0.988, 1, 2, 0.006, 0.05, 0.1)!; assert.ok(Math.abs(n - (0.988 - 2 * (1 - 0.95 * 0.9))) < 1e-9);
  assert.equal(taxedNet(0.5, 1, 2, 0.006, null, 0), null);
});
