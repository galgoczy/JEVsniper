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

test("PancakeSwap felvevő: csak WBNB-pár; vétel/eladás a WBNB irányából; ár a Sync-ből; pillanatképek 30/60 mp; kimenet a 60 mp-es árhoz", async () => {
  const { PancakeRecorder } = await import("../src/bnb/pancake.js");
  const { BNB } = await import("../src/bnb/addresses.js");
  const { encodeEventTopics, encodeAbiParameters, parseAbi } = await import("viem");
  const db = openDb(":memory:");
  let now = 1_000_000_000;
  const client = { getTransaction: async () => ({ from: "0x00000000000000000000000000000000000000c1", to: "0x10ed43c718714eb63d5aa57b78b54704e256024e" }) } as never;
  const rec = new PancakeRecorder({ db, client, now: () => now });
  const fac = parseAbi(["event PairCreated(address indexed token0, address indexed token1, address pair, uint256 allPairsLength)"]);
  const pairAbi = parseAbi(["event Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)", "event Sync(uint112 reserve0, uint112 reserve1)"]);
  const TOKEN = "0x00000000000000000000000000000000000000aa", PAIR = "0x00000000000000000000000000000000000000bb", OTHER = "0x00000000000000000000000000000000000000cc";
  const mk = (abi: readonly unknown[], name: string, args: Record<string, unknown>, address: string, block: bigint, i: number) => {
    const ev = (abi as Array<{ name: string; inputs: Array<{ name: string; indexed?: boolean; type: string }> }>).find((e) => e.name === name)!;
    const topics = encodeEventTopics({ abi: [ev], eventName: name, args } as never) as `0x${string}`[];
    const data = encodeAbiParameters(ev.inputs.filter((x) => !x.indexed) as never, ev.inputs.filter((x) => !x.indexed).map((x) => args[x.name]) as never);
    return { address, topics, data, blockNumber: block, transactionHash: `0x${String(i).padStart(64, "0")}`, logIndex: i } as never;
  };
  // WBNB < TOKEN címben? a WBNB 0xbb4c…, a TOKEN 0x…aa → token0 = TOKEN, token1 = WBNB
  await rec.onPairsCreated([mk(fac, "PairCreated", { token0: TOKEN, token1: BNB.wbnb, pair: PAIR, allPairsLength: 1n }, BNB.pancakeV2Factory, 100n, 1),
    mk(fac, "PairCreated", { token0: TOKEN, token1: OTHER, pair: OTHER, allPairsLength: 2n }, BNB.pancakeV2Factory, 100n, 2)], 100n, now);
  assert.equal((db.prepare("SELECT count(*) n FROM bnb_pairs").get() as { n: number }).n, 1);
  const p = db.prepare("SELECT * FROM bnb_pairs").get() as Record<string, unknown>; assert.equal(p.wbnb_is0, 0); assert.equal(p.creator, "0x00000000000000000000000000000000000000c1");
  const E = 10n ** 18n;
  // vétel: 1 WBNB be (amount1In), token ki; Sync: token 900, WBNB 11 → ár 11/900
  rec.ingestPairLogs([mk(pairAbi, "Sync", { reserve0: 900n * E, reserve1: 11n * E }, PAIR, 110n, 3), mk(pairAbi, "Swap", { sender: OTHER, amount0In: 0n, amount1In: E, amount0Out: 100n * E, amount1Out: 0n, to: OTHER }, PAIR, 110n, 4)], 110n, now);
  now += 61_000; rec.flush();
  const s60 = db.prepare("SELECT * FROM bnb_pair_snapshots WHERE window_sec = 60").get() as Record<string, number>;
  assert.equal(s60.buys, 1); assert.equal(s60.unique_buyers, 1); assert.ok(Math.abs(s60.bnb_in - 1) < 1e-9); assert.ok(Math.abs(s60.price - 11 / 900) < 1e-12); assert.ok(Math.abs(s60.liq_bnb - 11) < 1e-9);
  // eladás: WBNB ki (amount1Out); ár felére
  rec.ingestPairLogs([mk(pairAbi, "Sync", { reserve0: 1100n * E, reserve1: 6n * E }, PAIR, 300n, 5), mk(pairAbi, "Swap", { sender: OTHER, amount0In: 200n * E, amount1In: 0n, amount0Out: 0n, amount1Out: 5n * E, to: OTHER }, PAIR, 300n, 6)], 300n, now);
  assert.equal((db.prepare("SELECT count(*) n FROM bnb_pair_trades WHERE side = 'sell'").get() as { n: number }).n, 1);
  now += 25 * 3600_000; rec.flush();
  const o = db.prepare("SELECT * FROM bnb_pair_outcomes").get() as Record<string, number>;
  assert.ok(o.min_x < 0.5 && o.min_x > 0.4, `min_x ${o.min_x}`); assert.ok(Math.abs(o.min_liq_bnb - 6) < 1e-9); assert.ok(o.done_at > 0);
  assert.equal(rec.stats.tracked, 0);
  db.close();
});
