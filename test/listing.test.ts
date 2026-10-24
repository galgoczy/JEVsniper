import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";
import { openDb } from "../src/db/index.js";
import { simulate, LISTING_PLANS } from "../src/listing/sim.js";
import { ListingWatcher, listingSummary } from "../src/listing/watcher.js";

const cfg = loadConfig("config.yaml");
const plan = (n: string) => LISTING_PLANS.find((p) => p.name === n)!;
const cost = { gasBuyUsd: 0, gasSellUsd: 0, feePct: 0, mevPct: 0 };
const T0 = 1_000_000;

test("listázás-szimuláció: célok, stop, tartás, nyitott értékelés", () => {
  const up = [{ at: T0 + 60_000, price: 1.2, liq: 1e12 }, { at: T0 + 120_000, price: 1.35, liq: 1e12 }];
  const q = simulate(T0, 1, 1e12, up, plan("gyors"), cost);                                 // hatalmas likviditás → ~0 csúszás
  assert.equal(q.closed, true); assert.ok(Math.abs(q.value - 0.35) < 1e-3, String(q.value));   // 1,35x-en ad el (az első ≥1,3 minta)
  const down = [{ at: T0 + 60_000, price: 0.8, liq: 1e12 }];
  assert.ok(Math.abs(simulate(T0, 1, 1e12, down, plan("gyors"), cost).value + 0.2) < 1e-3);    // stop −15% alatt, 0,8-on
  const ladder = [{ at: T0 + 1, price: 1.6, liq: 1e12 }, { at: T0 + 2, price: 3.2, liq: 1e12 }, { at: T0 + 3, price: 2.0, liq: 1e12 }];
  const l = simulate(T0, 1, 1e12, ladder, plan("lepcsos"), cost);
  assert.equal(l.closed, true); assert.ok(Math.abs(l.value - (0.5 * 1.6 + 0.3 * 3.2 + 0.2 * 2.0 - 1)) < 1e-3, String(l.value)); // trailing −30% a 3,2-es csúcstól
  const h = simulate(T0, 1, 1e12, [{ at: T0 + 30 * 60_000, price: 1.1, liq: 1e12 }], plan("tartas_1h"), cost);
  assert.equal(h.closed, false); assert.ok(Math.abs(h.value - 0.1) < 1e-3);                      // még nyitott, utolsó áron
  const thin = simulate(T0, 1, 10, up.map((x) => ({ ...x, liq: 10 })), plan("gyors"), { gasBuyUsd: 0, gasSellUsd: 0 });          // vékony pool: a csúszás megeszi
  assert.ok(thin.value < 0.1, String(thin.value));
});

test("listázás-figyelő: első kör alapállapot, utána új Coinbase- és Robinhood-listázás → esemény, értesítés, ár", async () => {
  const db = openDb(":memory:");
  const A = "0x1234567890abcdef1234567890abcdef12345678", R = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd";
  let round = 0;
  const cur = () => [{ id: "OLD", supported_networks: [{ id: "base", contract_address: "0x0000000000000000000000000000000000000001" }] },
    ...(round > 0 ? [{ id: "NEWT", name: "New", status: "online", supported_networks: [{ id: "base", contract_address: A }] }] : [])];
  const prod = () => [{ id: "OLD-USD", base_currency: "OLD", quote_currency: "USD", status: "online", trading_disabled: false },
    ...(round > 0 ? [{ id: "NEWT-USD", base_currency: "NEWT", quote_currency: "USD", status: "online", trading_disabled: false }] : [])];
  const rh = () => ({ results: [{ id: "p1", symbol: "BTC-USD", tradability: "tradable", asset_currency: { code: "BTC" } },
    ...(round > 0 ? [{ id: "p2", symbol: "CAT-USD", tradability: "tradable", asset_currency: { code: "CAT", name: "Cat" } }] : [])] });
  const pair = (addr: string, chain: string, sym: string, liq: number) => ({ chainId: chain, dexId: "uniswap", pairAddress: "0xp", baseToken: { address: addr, symbol: sym }, priceUsd: "0.5", liquidity: { usd: liq } });
  const fake = (async (url: string) => {
    const body = url.endsWith("/currencies") ? cur() : url.endsWith("/products") ? prod() : url.includes("currency_pairs") ? rh()
      : url.includes("/search") ? { pairs: [pair(R, "robinhood", "CAT", 50_000), pair("0xfake", "robinhood", "CAT", 100), pair("0xeth", "ethereum", "CAT", 1e9)] }
      : url.includes("/tokens/") ? { pairs: [pair(A, "base", "NEWT", 80_000), pair(R, "robinhood", "CAT", 50_000)] } : {};
    return { ok: true, status: 200, json: async () => body } as Response;
  }) as typeof fetch;
  const msgs: string[] = [];
  const w = new ListingWatcher({ db, cfg, fetch: fake, notify: async (m) => { msgs.push(m); } });
  await w.tick();
  assert.equal(w.stats.events, 0); assert.equal(msgs.length, 0);                                // alapállapot
  round = 1; await w.tick();
  const evs = db.prepare("SELECT source, kind, symbol, chain, address, entry_price_usd FROM listing_events ORDER BY id").all() as Array<Record<string, unknown>>;
  assert.deepEqual(evs.map((e) => `${e.source}/${e.kind}/${e.symbol}`), ["coinbase/currency_added/NEWT", "coinbase/trading_live/NEWT", "robinhood/rh_tradable/CAT"]);
  assert.equal(evs[2]!.address, R);                                                             // a legnagyobb likviditású RH-pár, nem az ethereumos
  assert.equal(evs[0]!.entry_price_usd, 0.5);
  assert.equal(msgs.length, 3); assert.match(msgs[0]!, /Listázás \(coinbase/);
  await w.tick(); assert.equal(w.stats.events, 3);                                               // nincs ismételt esemény
  const sum = listingSummary(db, cfg, 0);
  assert.equal(sum.events, 3); assert.equal(sum.plans.length, LISTING_PLANS.length);
});

test("listázás: ár nélküli esemény (még nincs DEX-pool) → később, ≥1000 USD likviditású pár megjelenésekor késleltetett belépés", async () => {
  const db = openDb(":memory:");
  const A = "0xeeee77bc7e82c0d4166d52f58239d4c5bf41eeee";
  let round = 0, poolLiq = 0;
  const cur = () => [{ id: "OLD", supported_networks: [{ id: "base", contract_address: "0x0000000000000000000000000000000000000001" }] },
    ...(round > 0 ? [{ id: "WHUF", name: "Whuffie", status: "online", supported_networks: [{ id: "base", contract_address: A }] }] : [])];
  const fake = (async (url: string) => {
    const body = url.endsWith("/currencies") ? cur() : url.endsWith("/products") ? [] : url.includes("currency_pairs") ? { results: [] }
      : url.includes("/tokens/") ? { pairs: poolLiq ? [{ chainId: "base", dexId: "uniswap", pairAddress: "0xp", baseToken: { address: A, symbol: "WHUF" }, priceUsd: "0.02", liquidity: { usd: poolLiq } }] : [] } : {};
    return { ok: true, status: 200, json: async () => body } as Response;
  }) as typeof fetch;
  const msgs: string[] = [];
  const w = new ListingWatcher({ db, cfg, fetch: fake, notify: async (m) => { msgs.push(m); } });
  (w as unknown as { lastLateCheck: number }).lastLateCheck = 0;
  await w.tick(); round = 1; await w.tick();
  assert.equal((db.prepare("SELECT entry_price_usd FROM listing_events").get() as { entry_price_usd: number | null }).entry_price_usd, null);
  assert.match(msgs[0]!, /7 napig 5 percenként/);
  poolLiq = 300; (w as unknown as { lastLateCheck: number }).lastLateCheck = 0; await w.tick();   // porszem-pool: nem belépés
  assert.equal((db.prepare("SELECT entry_price_usd FROM listing_events").get() as { entry_price_usd: number | null }).entry_price_usd, null);
  poolLiq = 50_000; (w as unknown as { lastLateCheck: number }).lastLateCheck = 0; await w.tick();
  const e = db.prepare("SELECT entry_price_usd, entry_at, note FROM listing_events").get() as { entry_price_usd: number; entry_at: number; note: string };
  assert.equal(e.entry_price_usd, 0.02); assert.ok(e.entry_at > 0); assert.match(e.note, /késleltetett belépés/);
  assert.match(msgs[msgs.length - 1]!, /késleltetett árnyék-belépés: WHUF/);
  assert.equal(listingSummary(db, cfg, 0).events, 1);
});
