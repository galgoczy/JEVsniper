import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db/index.js";
import { decodePumpEvent, eventsFromLogs, curvePrice, curveProgressPct, INITIAL_REAL_TOKEN_RESERVES, SOL_ZERO_PUBKEY, base58 } from "../src/sol/pump.js";
import { SolRecorder } from "../src/sol/recorder.js";

// Borsh-kódoló a teszthez (az IDL mezősorrendje szerint)
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const fromB58 = (s: string) => { let n = 0n; for (const c of s) n = n * 58n + BigInt(B58.indexOf(c)); const out: number[] = []; while (n > 0n) { out.unshift(Number(n % 256n)); n /= 256n; } let z = 0; for (const c of s) { if (c === "1") z++; else break; } return Buffer.from([...Array(z).fill(0), ...out]); };
const pk = (seed: number) => base58(Buffer.alloc(32, seed));
const enc = { u8: (v: number) => Buffer.from([v]), bool: (v: boolean) => Buffer.from([v ? 1 : 0]), u64: (v: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(v); return b; }, i64: (v: bigint) => { const b = Buffer.alloc(8); b.writeBigInt64LE(v); return b; },
  pk: (s: string) => { const b = fromB58(s); return Buffer.concat([Buffer.alloc(32 - b.length), b]); }, str: (s: string) => { const d = Buffer.from(s, "utf8"); const l = Buffer.alloc(4); l.writeUInt32LE(d.length); return Buffer.concat([l, d]); } };
const b64 = (disc: number[], ...parts: Buffer[]) => "Program data: " + Buffer.concat([Buffer.from(disc), ...parts]).toString("base64");
const MINT = pk(7), CREATOR = pk(9), BUYER1 = pk(11), BUYER2 = pk(12);
const create = (ts: number) => b64([27, 114, 169, 77, 222, 235, 99, 118], enc.str("Teszt"), enc.str("TST"), enc.str("ipfs://x"), enc.pk(MINT), enc.pk(pk(8)), enc.pk(CREATOR), enc.pk(CREATOR), enc.i64(BigInt(ts)),
  enc.u64(1_073_000_000_000_000n), enc.u64(30_000_000_000n), enc.u64(INITIAL_REAL_TOKEN_RESERVES), enc.u64(10n ** 15n), enc.pk(pk(1)), enc.bool(false), enc.bool(false), enc.pk(SOL_ZERO_PUBKEY), enc.u64(0n), enc.u64(0n), enc.bool(false));
const trade = (ts: number, user: string, isBuy: boolean, sol: bigint, vsol: bigint, vtok: bigint, realTok: bigint) => b64([189, 219, 127, 211, 78, 230, 97, 238], enc.pk(MINT), enc.u64(sol), enc.u64(10n ** 9n), enc.bool(isBuy), enc.pk(user), enc.i64(BigInt(ts)),
  enc.u64(vsol), enc.u64(vtok), enc.u64(vsol - 30_000_000_000n), enc.u64(realTok), enc.pk(pk(2)), enc.u64(100n), enc.u64(sol / 100n), enc.pk(CREATOR), enc.u64(0n), enc.u64(0n), Buffer.from("tail-amit-nem-olvasunk"));
const complete = (ts: number) => b64([95, 114, 97, 156, 212, 46, 152, 8], enc.pk(BUYER1), enc.pk(MINT), enc.pk(pk(8)), enc.i64(BigInt(ts)), enc.pk(SOL_ZERO_PUBKEY));

test("Pump.fun esemény-dekódolás: create / trade / complete az IDL szerint; ismeretlen diszkriminátor kihagyva", () => {
  const c = decodePumpEvent(create(1_790_000_000).slice(14)); assert.equal(c?.kind, "create");
  if (c?.kind === "create") { assert.equal(c.symbol, "TST"); assert.equal(c.mint, MINT); assert.equal(c.creator, CREATOR); assert.equal(c.quoteMint, SOL_ZERO_PUBKEY); assert.equal(c.virtualSolReserves, 30_000_000_000n); }
  const t = decodePumpEvent(trade(1_790_000_010, BUYER1, true, 10n ** 9n, 31_000_000_000n, 1_038_000_000_000_000n, 758_100_000_000_000n).slice(14));
  assert.equal(t?.kind, "trade"); if (t?.kind === "trade") { assert.equal(t.isBuy, true); assert.equal(t.user, BUYER1); assert.equal(t.virtualSolReserves, 31_000_000_000n); assert.equal(t.feeBasisPoints, 100n); }
  assert.equal(decodePumpEvent(Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9]).toString("base64")), null);
  assert.equal(eventsFromLogs(["Program log: x", complete(1_790_000_100), "Program data: AAAA"]).length, 1);
  assert.ok(Math.abs(curvePrice(30_000_000_000n, 1_073_000_000_000_000n) - 30 / 1_073_000_000) < 1e-15);
  assert.ok(Math.abs(curveProgressPct(758_100_000_000_000n) - 4.41) < 0.01);
  assert.equal(curveProgressPct(0n), 100);
});

test("SOL felvevő: token, kötések, pillanatképek 30/60 mp-nél, kimenet a 60 mp-es árhoz, görbe-teljesülés", () => {
  const db = openDb(":memory:");
  let now = 1_790_000_000_000;
  const rec = new SolRecorder({ db, now: () => now, fetchFn: (async () => ({ json: async () => ({ price: "0" }) })) as unknown as typeof fetch });
  const T0 = 1_790_000_000;
  rec.ingest(eventsFromLogs([create(T0)]), "sig0");
  rec.ingest(eventsFromLogs([trade(T0 + 5, CREATOR, true, 10n ** 9n, 31_000_000_000n, 1_038_000_000_000_000n, 758_100_000_000_000n)]), "sig1");   // készítő vesz → nem külső vevő
  rec.ingest(eventsFromLogs([trade(T0 + 20, BUYER1, true, 2n * 10n ** 9n, 33_000_000_000n, 975_000_000_000_000n, 695_100_000_000_000n)]), "sig2");
  now = (T0 + 31) * 1000; rec.flush();
  const s30 = db.prepare("SELECT * FROM sol_snapshots WHERE window_sec = 30").get() as Record<string, number>;
  assert.equal(s30.buys, 2); assert.equal(s30.unique_buyers, 1); assert.equal(s30.creator_bought, 1); assert.ok(Math.abs(s30.sol_in - 3) < 1e-9); assert.ok(s30.progress_pct > 12 && s30.progress_pct < 13);
  rec.ingest(eventsFromLogs([trade(T0 + 50, BUYER2, true, 10n ** 9n, 34_000_000_000n, 946_000_000_000_000n, 666_100_000_000_000n)]), "sig3");
  now = (T0 + 61) * 1000; rec.flush();
  const s60 = db.prepare("SELECT unique_buyers, price FROM sol_snapshots WHERE window_sec = 60").get() as { unique_buyers: number; price: number };
  assert.equal(s60.unique_buyers, 2);
  // 60 mp után az ár duplájára megy, majd a készítő elad, aztán teljesül a görbe
  rec.ingest(eventsFromLogs([trade(T0 + 120, BUYER1, true, 40n * 10n ** 9n, 74_000_000_000n, 435_000_000_000_000n, 155_100_000_000_000n)]), "sig4");
  rec.ingest(eventsFromLogs([trade(T0 + 130, CREATOR, false, 10n ** 9n, 73_000_000_000n, 441_000_000_000_000n, 161_100_000_000_000n)]), "sig5");
  rec.ingest(eventsFromLogs([complete(T0 + 200)]), "sig6");
  now = (T0 + 205) * 1000; rec.flush();
  const out = db.prepare("SELECT * FROM sol_outcomes").get() as Record<string, number>;
  assert.ok(Math.abs(out.ref_price - s60.price) < 1e-18); assert.ok(out.max_x > 4, `max_x ${out.max_x}`); assert.equal(out.complete_at, (T0 + 200) * 1000);
  const s180 = db.prepare("SELECT creator_sold, sells FROM sol_snapshots WHERE window_sec = 180").get() as { creator_sold: number; sells: number };
  assert.equal(s180.creator_sold, 1); assert.equal(s180.sells, 1);
  assert.equal((db.prepare("SELECT count(*) n FROM sol_trades").get() as { n: number }).n, 5);
  assert.equal((db.prepare("SELECT kind FROM sol_grads").get() as { kind: string }).kind, "complete");
  // nem követett token kötése nem íródik
  const other = decodePumpEvent(trade(T0 + 300, BUYER1, true, 10n ** 9n, 31_000_000_000n, 1_038_000_000_000_000n, 758_100_000_000_000n).slice(14))!;
  rec.ingest([{ ...other, mint: pk(99) } as typeof other], "sig7");
  assert.equal((db.prepare("SELECT count(*) n FROM sol_trades").get() as { n: number }).n, 5);
  now = (T0 + 25 * 3600) * 1000; rec.flush();
  assert.equal(rec.stats.tracked, 0); assert.ok((db.prepare("SELECT done_at FROM sol_outcomes").get() as { done_at: number }).done_at > 0);
  db.close();
});

test("SOL visszajátszás: 2x-nél fele eladva, utána −40% vészfék; költségek levonva; nyitva maradt rész az utolsó áron", async () => {
  const { replayPosition, solRandomPick } = await import("../src/sol/replay.js");
  const { loadConfig } = await import("../src/config.js");
  const cfg = loadConfig("config.yaml");
  const zero = { fee_pct: 0, mev_pct: 0, tx_sol: 0 };
  // 1 → 2 (fele el: +1) → 0,5 (vészfék: a maradék fele 0,5-ön: +0,25) → nettó 1+0,25−1 = +0,25
  const r = replayPosition(1, 0, [{ at: 1, price: 1.5 }, { at: 2, price: 2 }, { at: 3, price: 0.5 }], "live", 1, cfg, zero);
  assert.ok(Math.abs(r.net - 0.25) < 1e-9, `net ${r.net}`); assert.equal(r.openAtEnd, false); assert.match(r.reason, /price_drop/);
  // nincs esemény → nyitva a végén, utolsó áron (1,2x) → +0,2
  const o = replayPosition(1, 0, [{ at: 5, price: 1.2 }], "live", 1, cfg, zero);
  assert.ok(Math.abs(o.net - 0.2) < 1e-9); assert.equal(o.openAtEnd, true);
  // költséggel: 1,25% + 0,3% irányonként, 2 tx × 0,0001 SOL; 1 SOL belépő, ár változatlan → kb. −3,1%
  const c = replayPosition(1, 0, [{ at: 5, price: 1 }], "live", 1, cfg);
  assert.ok(c.net < -0.03 && c.net > -0.032, `net ${c.net}`);
  // a belépés előtti kötés nem számít
  assert.ok(Math.abs(replayPosition(1, 10, [{ at: 5, price: 0.1 }, { at: 11, price: 1.1 }], "live", 1, cfg, zero).net - 0.1) < 1e-9);
  let n = 0; for (let i = 0; i < 5000; i++) if (solRandomPick(`mint${i}`)) n++;
  assert.ok(n > 850 && n < 1150, `véletlen minta ${n}/5000`);
});
