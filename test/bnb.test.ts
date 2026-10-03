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
