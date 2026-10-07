/**
 * Solana (PumpSwap-poolok + Pump.fun-túlélők) és BNB (PancakeSwap) visszajátszás – harmadik kör (2026-10-07).
 * A jelöltek a docs/FELTETELEZESEK.md 2026-10-07 bejegyzésében ELŐRE rögzítve. Csak olvas; a riport a reports/ mappába íródik.
 *   npm run replay:solbnb [-- --horizon-h 6 --only A,S,B --size-usd 1]
 * Módszer: időrendi bontás (első 2/3 tanító / utolsó 1/3 ellenőrző az entitás indulása szerint); a kilépési tervet a TANÍTÓN
 * választjuk, az ELLENŐRZŐN jelentjük (90% bootstrap CI); véletlen kontroll (20%) és „minden” alapvonal; késés SOL 2 mp / BNB 3 mp.
 */
import fs from "node:fs";
import { loadConfig } from "../src/config.js";
import { openDb } from "../src/db/index.js";
import { bootstrapCI } from "../src/report/index.js";
import { replayPosition, solRandomPick, type PricePoint, type SolCost } from "../src/sol/replay.js";

const cfg = loadConfig(); const db = openDb(cfg.db.path);
const arg = (k: string, d: string) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1]! : d; };
const HORIZON = Number(arg("--horizon-h", "6")) * 3600_000;
const ONLY = arg("--only", "A,S,B").split(",");
const SIZE_USD = Number(arg("--size-usd", "1"));
const now = Date.now();
const meta = (k: string) => Number((db.prepare("SELECT value FROM meta WHERE key = ?").get(k) as { value: string } | undefined)?.value ?? 0);
const solUsd = meta("sol_usd"), bnbUsd = meta("bnb_usd");
if (!(solUsd > 0) || !(bnbUsd > 0)) { console.log("❌ nincs SOL/USD vagy BNB/USD a meta táblában"); process.exit(1); }

type PP = PricePoint & { liq?: number; side?: string; amt?: number; prog?: number };
type Snap = Record<string, number>;
type Ent = { id: string; created: number; path: PP[]; snaps: Map<number, Snap>; m: Record<string, unknown> };
type Entry = { at: number; price: number } | null;
type Cand = { name: string; pick: (e: Ent) => Entry };
type Ds = { key: string; title: string; ents: Ent[]; cands: Cand[]; latencyMs: number; cost: SolCost; sizeNative: number; costFor?: (e: Ent) => SolCost };

const PLANS = ["live", "C", "run70", "tp1.5_sl30", "tp2_sl40", "tp3_sl50", "tr40"];
const AMM_COST: SolCost = { fee_pct: 0.25, mev_pct: 0.3, tx_sol: 0.0001 };
const CURVE_COST: SolCost = { fee_pct: 1.25, mev_pct: 0.3, tx_sol: 0.0001 };
const BNB_COST: SolCost = { fee_pct: 0.25, mev_pct: 0.5, tx_sol: 0.006 / bnbUsd }; // tx_sol itt BNB-ben: ~0,006 USD gáz/tx (0,05 gwei)

// --- kihúzott likviditás (2026-10-07, az első futás tanulsága): a kiürült pool/pár árpontjai nem valósak (porszem-vétel 10^27-szeres „árat” ad);
// az első ilyen ponttól a pozíció eladhatatlan → érték nulla. Az entitás útvonalát itt csonkoljuk, és egy ~0 árpontot fűzünk a végére.
const RUG_PRICE = 1e-30;
function truncateAtRug(e: Ent, invalidIdx: number) {
  if (invalidIdx < 0) return;
  const at = e.path[invalidIdx]!.at;
  e.m.ruggedAt = at; e.path = e.path.slice(0, invalidIdx); e.path.push({ at, price: RUG_PRICE });
}
/** Konstans szorzatú pár: a kötés BNB-mennyiségéből és az árelmozdulásból a kötés ELŐTTI natív tartalék. */
function impliedReserve(prevPrice: number, price: number, amt: number): number {
  if (!(prevPrice > 0) || !(price > 0) || !(amt > 0)) return Infinity;
  const r = Math.sqrt(price / prevPrice);
  if (Math.abs(r - 1) < 1e-9) return Infinity;
  return r > 1 ? amt / (r - 1) : amt / (1 - r);
}

/** Eladhatatlan (honeypot-gyanús): ≥ 10 vétel és egyetlen eladás sem a horizonton → a pozíció a végén nullát ér (belépni lehet – ez a valós kockázat). */
function markHoneypots(ents: Iterable<Ent>): number {
  let n = 0;
  for (const e of ents) {
    if (e.m.ruggedAt !== undefined) continue;
    let buys = 0, sells = 0; for (const x of e.path) { if (x.side === "buy") buys++; else if (x.side === "sell") sells++; }
    if (buys >= 10 && sells === 0) { n++; e.m.honeypot = true; const last = e.path[e.path.length - 1]!; e.path.push({ at: last.at + 1, price: RUG_PRICE }); }
  }
  return n;
}

/** Pillanatkép csak akkor számít, ha tényleg a kívánt időpontban készült (2026-10-07: a késve észlelt entitásoknál az összes ablak egyszerre, utólag íródott). */
const SNAP_TOL_MS = 90_000;
const timely = (e: Ent, w: number, at: number) => Math.abs(at - (e.created + w * 1000)) <= SNAP_TOL_MS;

// --- belépési segédek
const lastAt = (p: PP[], t: number) => { let r: PP | null = null; for (const x of p) { if (x.at > t) break; r = x; } return r; };
/** Időzített belépés: ha a [jelzés, jelzés+késés) sávban volt kötés, az utána következő első kötés ára; különben a pillanatkép (vagy az utolsó) ár. */
// Belépési ár CSAK a kötésekből (2026-10-07): az ár két kötés között nem változik, ezért az utolsó kötés ára a pillanatnyi ár;
// a pillanatképek ára nem használható (a késve észlelt entitásoknál utólagos). `_snapPrice` csak a hívások kompatibilitása miatt marad.
const atT = (e: Ent, sec: number, lat: number, _snapPrice?: number): Entry => {
  const s = e.created + sec * 1000; if (s > e.created + HORIZON) return null;
  const moved = e.path.some((z) => z.at > s && z.at < s + lat);
  if (moved) { const y = e.path.find((z) => z.at >= s + lat); return y && y.price !== RUG_PRICE ? { at: y.at, price: y.price } : null; }
  const lb = lastAt(e.path, s);
  if (!lb || !(lb.price > 0) || lb.price === RUG_PRICE) return null;
  return { at: s + lat, price: lb.price };
};
/** Eseményvezérelt belépés: a jelző kötés utáni első, legalább `lat`-tal későbbi kötés árán (ha nincs, nincs belépés). */
const afterIdx = (e: Ent, i: number, lat: number): Entry => { const t = e.path[i]!.at; for (let k = i + 1; k < e.path.length; k++) if (e.path[k]!.at >= t + lat) return { at: e.path[k]!.at, price: e.path[k]!.price }; return null; };
const sn = (e: Ent, w: number, f: string) => e.snaps.get(w)?.[f];
const has = (e: Ent, ...ws: number[]) => ws.every((w) => e.snaps.has(w));

// ============ A) PumpSwap-poolok ============
function loadAmm(): Ds {
  const lat = 2000;
  const pools = db.prepare("SELECT pool, created_at, coin_creator, mayhem FROM sol_amm_pools WHERE quote_sol = 1 AND created_at < ? ORDER BY created_at").all(now - HORIZON) as Array<{ pool: string; created_at: number; coin_creator: string | null; mayhem: number | null }>;
  const byCreator = new Map<string, number[]>();
  for (const r of db.prepare("SELECT coin_creator c, created_at a FROM sol_amm_pools WHERE coin_creator IS NOT NULL").iterate() as Iterable<{ c: string; a: number }>) (byCreator.get(r.c) ?? byCreator.set(r.c, []).get(r.c)!).push(r.a);
  const ents = new Map<string, Ent>();
  for (const p of pools) ents.set(p.pool, { id: p.pool, created: p.created_at, path: [], snaps: new Map(), m: { mayhem: p.mayhem === 1, priorPool: (byCreator.get(p.coin_creator ?? "") ?? []).some((a) => a < p.created_at) } });
  for (const s of db.prepare("SELECT pool, window_sec w, at, buys, sells, unique_buyers ub, quote_in qin, quote_out qout, price, pool_quote pq FROM sol_amm_snapshots").iterate() as Iterable<{ pool: string; w: number; at: number } & Snap>) { const e = ents.get(s.pool); if (e && timely(e, s.w, s.at)) e.snaps.set(s.w, { buys: s.buys, sells: s.sells, ub: s.ub, qin: s.qin, qout: s.qout, price: s.price, pq: s.pq }); }
  for (const r of db.prepare("SELECT pool, at, side, quote_sol q, price, pool_quote pq FROM sol_amm_trades ORDER BY pool, at, id").iterate() as Iterable<{ pool: string; at: number; side: string; q: number; price: number; pq: number }>) {
    const e = ents.get(r.pool); if (!e || r.at > e.created + HORIZON || !(r.price > 0)) continue; e.path.push({ at: r.at, price: r.price, liq: r.pq, side: r.side, amt: r.q });
  }
  const minLiq = Math.max(0.2, 20 * SIZE_USD / solUsd); // SOL: ennyi tartalék alatt a pool kiürültnek számít (eladhatatlan)
  for (const e of ents.values()) truncateAtRug(e, e.path.findIndex((x) => (x.liq ?? 0) < minLiq));
  console.log(`A) eladhatatlan (≥10 vétel, 0 eladás): ${markHoneypots(ents.values())}`);
  const list = [...ents.values()].filter((e) => e.path.length >= 5);
  const pullback = (e: Ent): Entry => { let peak = 0, peakLiq = 0; for (let i = 0; i < e.path.length; i++) { const x = e.path[i]!; peak = Math.max(peak, x.price); peakLiq = Math.max(peakLiq, x.liq ?? 0); if (x.at >= e.created + 300_000 && x.price <= 0.6 * peak && (x.liq ?? 0) >= 0.8 * peakLiq) return afterIdx(e, i, lat); } return null; };
  const breakout = (e: Ent): Entry => { let peak = 0, peakAt = 0; for (let i = 0; i < e.path.length; i++) { const x = e.path[i]!; if (x.price > peak) { if (x.at >= e.created + 900_000 && peakAt > 0 && x.at - peakAt >= 600_000) return afterIdx(e, i, lat); peak = x.price; peakAt = x.at; } } return null; };
  const deepDip = (e: Ent): Entry => { const p60 = sn(e, 60, "price"), q60 = sn(e, 60, "pq"); if (!p60 || !q60) return null; for (let i = 0; i < e.path.length; i++) { const x = e.path[i]!; if (x.at > e.created + 3600_000) break; if (x.at > e.created + 60_000 && x.price <= 0.5 * p60 && (x.liq ?? 0) >= 0.7 * q60) return afterIdx(e, i, lat); } return null; };
  const whale = (e: Ent): Entry => { for (let i = 0; i < e.path.length; i++) { const x = e.path[i]!; if (x.at >= e.created + 300_000 && x.side === "buy" && (x.amt ?? 0) >= 5) return afterIdx(e, i, lat); } return null; };
  const burst = (e: Ent): Entry => { const blocks = new Map<number, number>(); for (let i = 0; i < e.path.length; i++) { const x = e.path[i]!; if (x.side !== "buy") continue; const k = Math.floor((x.at - e.created) / 300_000); const c = (blocks.get(k) ?? 0) + 1; blocks.set(k, c); if (k >= 3) { const prev = blocks.get(k - 1) ?? 0; if (c >= 30 && c >= 3 * prev) return afterIdx(e, i, lat); } } return null; };
  const cands: Cand[] = [
    { name: "A0 véletlen 20% +5p", pick: (e) => (solRandomPick(e.id) ? atT(e, 300, lat, sn(e, 300, "price")) : null) },
    { name: "A1 minden +60s", pick: (e) => atT(e, 60, lat, sn(e, 60, "price")) },
    { name: "A2 minden +5p", pick: (e) => atT(e, 300, lat, sn(e, 300, "price")) },
    { name: "A3 minden +15p", pick: (e) => atT(e, 900, lat, sn(e, 900, "price")) },
    { name: "A4 minden +60p", pick: (e) => atT(e, 3600, lat, sn(e, 3600, "price")) },
    { name: "A5 lendület +5p (tartalék nő, vevők≥100)", pick: (e) => (has(e, 60, 300) && sn(e, 300, "pq")! > sn(e, 60, "pq")! && sn(e, 300, "ub")! >= 100 ? atT(e, 300, lat, sn(e, 300, "price")) : null) },
    { name: "A6 erős lendület +15p (ár emelkedő, tartalék tart)", pick: (e) => (has(e, 60, 300, 900) && sn(e, 900, "price")! > sn(e, 300, "price")! && sn(e, 300, "price")! > sn(e, 60, "price")! && sn(e, 900, "pq")! >= sn(e, 300, "pq")! ? atT(e, 900, lat, sn(e, 900, "price")) : null) },
    { name: "A7 visszaesés-vétel (−40% csúcstól, tartalék tart)", pick: pullback },
    { name: "A8 kitörés (új csúcs 15p után)", pick: breakout },
    { name: "A9 mély esés (−50% a 60s-árhoz, tartalék ≥70%)", pick: deepDip },
    { name: "A10 csendes gyűjtés +15p", pick: (e) => (has(e, 300, 900) && sn(e, 900, "sells")! < sn(e, 900, "buys")! && sn(e, 900, "ub")! >= 1.5 * sn(e, 300, "ub")! && Math.abs(sn(e, 900, "price")! / sn(e, 300, "price")! - 1) <= 0.2 ? atT(e, 900, lat, sn(e, 900, "price")) : null) },
    { name: "A11 bálna-vétel ≥5 SOL (+5p után)", pick: whale },
    { name: "A12 késői volumen-robbanás", pick: burst },
    { name: "A13 mayhem-pool +5p", pick: (e) => (e.m.mayhem ? atT(e, 300, lat, sn(e, 300, "price")) : null) },
    { name: "A14 készítőnek volt korábbi migrált tokenje +5p", pick: (e) => (e.m.priorPool ? atT(e, 300, lat, sn(e, 300, "price")) : null) },
    { name: "A15 nagy pool (tartalék(60s) ≥150 SOL) +5p", pick: (e) => ((sn(e, 60, "pq") ?? 0) >= 150 ? atT(e, 300, lat, sn(e, 300, "price")) : null) },
  ];
  return { key: "A", title: "PumpSwap-poolok (graduált Solana-tokenek)", ents: list, cands, latencyMs: lat, cost: AMM_COST, sizeNative: SIZE_USD / solUsd };
}

// ============ S) Pump.fun-túlélők (30 perc után) ============
function loadSurvivors(): Ds {
  const lat = 2000;
  const rows = db.prepare(`SELECT o.mint, t.created_at c, s.progress_pct prog FROM sol_outcomes o JOIN sol_tokens t ON t.mint = o.mint JOIN sol_snapshots s ON s.mint = o.mint AND s.window_sec = 1800
    WHERE o.ref30_price IS NOT NULL AND s.progress_pct >= 10 AND t.quote_sol = 1 AND t.created_at < ? ORDER BY t.created_at`).all(now - HORIZON) as Array<{ mint: string; c: number; prog: number }>;
  const ents = new Map<string, Ent>();
  for (const r of rows) ents.set(r.mint, { id: r.mint, created: r.c, path: [], snaps: new Map(), m: { prog30: r.prog, late5: 0 } });
  for (const s of db.prepare("SELECT mint, window_sec w, at, buys, sells, unique_buyers ub, price, progress_pct prog FROM sol_snapshots WHERE window_sec IN (600, 1800)").iterate() as Iterable<{ mint: string; w: number; at: number } & Snap>) { const e = ents.get(s.mint); if (e && timely(e, s.w, s.at)) e.snaps.set(s.w, { buys: s.buys, sells: s.sells, ub: s.ub, price: s.price, prog: s.prog }); }
  const late = new Map<string, Set<string>>();
  for (const r of db.prepare("SELECT mint, at, side, user, price, progress_pct prog FROM sol_trades ORDER BY mint, at, id").iterate() as Iterable<{ mint: string; at: number; side: string; user: string; price: number; prog: number }>) {
    const e = ents.get(r.mint); if (!e || !(r.price > 0)) continue;
    if (r.at >= e.created + 1500_000 && r.at < e.created + 1800_000 && r.side === "buy") (late.get(r.mint) ?? late.set(r.mint, new Set()).get(r.mint)!).add(r.user);
    if (r.at >= e.created + 1800_000 && r.at <= e.created + HORIZON) e.path.push({ at: r.at, price: r.price, prog: r.prog, side: r.side });
  }
  for (const [m, s] of late) ents.get(m)!.m.late5 = s.size;
  // migráció után: a PumpSwap-pool kötései folytatják az útvonalat (a Pump.fun a görbe záróárán nyitja a poolt)
  // csak a HIVATALOS migrációs pool (init ≥ 50 SOL, vagy a migrációs eseményből felvett), és csak ha a felvevő a pool születésekor már látta
  // (a pool létrejötte ≤ 10 perccel az utolsó görbe-kötés után) – különben órákkal későbbi árat ragasztanánk a görbe végére
  const lastCurveAt = new Map<string, number>(); for (const e of ents.values()) if (e.path.length) lastCurveAt.set(e.id, e.path[e.path.length - 1]!.at);
  const poolOf = new Map<string, string>();
  for (const r of db.prepare("SELECT pool, base_mint, created_at, init_quote FROM sol_amm_pools WHERE quote_sol = 1 AND (init_quote IS NULL OR init_quote >= 50) ORDER BY created_at").iterate() as Iterable<{ pool: string; base_mint: string; created_at: number; init_quote: number | null }>) {
    const lc = lastCurveAt.get(r.base_mint); if (lc === undefined || r.created_at > lc + 600_000 || r.created_at < lc - 600_000) continue;
    if (![...poolOf.values()].includes(r.base_mint)) poolOf.set(r.pool, r.base_mint);
  }
  const minLiq = Math.max(0.2, 20 * SIZE_USD / solUsd);
  for (const r of db.prepare("SELECT pool, at, price, pool_quote pq FROM sol_amm_trades ORDER BY pool, at, id").iterate() as Iterable<{ pool: string; at: number; price: number; pq: number }>) {
    const mint = poolOf.get(r.pool); if (!mint) continue; const e = ents.get(mint)!; if (r.at > e.created + HORIZON || !(r.price > 0)) continue; e.path.push({ at: r.at, price: r.price, prog: 100, liq: r.pq });
  }
  for (const e of ents.values()) { e.path.sort((a, b) => a.at - b.at); e.m.stitched = poolOf.size; truncateAtRug(e, e.path.findIndex((x) => x.prog === 100 && (x.liq ?? 0) < minLiq)); }
  const stitchedN = new Set(poolOf.values()).size;
  const list = [...ents.values()].filter((e) => e.path.length >= 3);
  const band = (e: Ent, lo: number, hi: number) => { const p = e.m.prog30 as number; return p >= lo && p < hi; };
  const crossing = (e: Ent, level: number): Entry => { let prev = e.m.prog30 as number; for (let i = 0; i < e.path.length; i++) { const x = e.path[i]!; const pr = x.prog ?? 0; if (prev < level && pr >= level && pr < 100) return afterIdx(e, i, lat); prev = pr; } return null; };
  const at30 = (e: Ent) => atT(e, 1800, lat, sn(e, 1800, "price"));
  const cands: Cand[] = [
    { name: "S0 véletlen 20% +30p (10%+ haladás)", pick: (e) => (solRandomPick(e.id) ? at30(e) : null) },
    { name: "S1a 10–30% haladás +30p", pick: (e) => (band(e, 10, 30) ? at30(e) : null) },
    { name: "S1b 30–50% +30p", pick: (e) => (band(e, 30, 50) ? at30(e) : null) },
    { name: "S1c 50–90% +30p", pick: (e) => (band(e, 50, 90) ? at30(e) : null) },
    { name: "S1d 50–90% és ≥5 vevő az utolsó 5 percben", pick: (e) => (band(e, 50, 90) && (e.m.late5 as number) >= 5 ? at30(e) : null) },
    { name: "S1e haladás +15 pont 10p→30p", pick: (e) => (has(e, 600, 1800) && sn(e, 1800, "prog")! - sn(e, 600, "prog")! >= 15 ? at30(e) : null) },
    { name: "S2 90%-átlépés 30p után (görbe→AMM)", pick: (e) => crossing(e, 90) },
    { name: "S3 50%-átlépés 30p után", pick: (e) => crossing(e, 50) },
  ];
  return { key: "S", title: `Pump.fun-túlélők (30 perc után; ${stitchedN} tokennél a hivatalos AMM-pool hozzáfűzve)`, ents: list, cands, latencyMs: lat, cost: CURVE_COST, sizeNative: SIZE_USD / solUsd };
}

// ============ B) PancakeSwap-indítások ============
function loadBnb(): Ds {
  const lat = 3000;
  const ROUTER = "0x10ed43c718714eb63d5aa57b78b54704e256024e", OTHER = "0xc9b7cc619200418649f9e3fc718e45028dfe9c47";
  const pairs = db.prepare("SELECT pair, created_at, tx_to FROM bnb_pairs WHERE created_at < ? ORDER BY created_at").all(now - HORIZON) as Array<{ pair: string; created_at: number; tx_to: string | null }>;
  const ents = new Map<string, Ent>();
  for (const p of pairs) ents.set(p.pair, { id: p.pair, created: p.created_at, path: [], snaps: new Map(), m: { to: (p.tx_to ?? "").toLowerCase() } });
  for (const s of db.prepare("SELECT pair, window_sec w, at, buys, sells, unique_buyers ub, bnb_in bin, bnb_out bout, price, liq_bnb liq FROM bnb_pair_snapshots").iterate() as Iterable<{ pair: string; w: number; at: number } & Snap>) { const e = ents.get(s.pair); if (e && timely(e, s.w, s.at)) e.snaps.set(s.w, { buys: s.buys, sells: s.sells, ub: s.ub, bin: s.bin, bout: s.bout, price: s.price, liq: s.liq }); }
  for (const r of db.prepare("SELECT pair, at, side, bnb, price FROM bnb_pair_trades ORDER BY pair, at, block, log_index").iterate() as Iterable<{ pair: string; at: number; side: string; bnb: number; price: number }>) {
    const e = ents.get(r.pair); if (!e || r.at > e.created + HORIZON || !(r.price > 0)) continue; e.path.push({ at: r.at, price: r.price, side: r.side, amt: r.bnb });
  }
  const minRes = Math.max(0.05, 20 * SIZE_USD / bnbUsd); // BNB: ennyi (a kötésekből visszaszámolt) tartalék alatt a pár kiürült
  // érvényességi lánc: csak BNB-t mozgató kötések; egy pont csak akkor érvényes, ha az utolsó érvényes ponthoz képest a tartalék ≥ minRes
  // (porszem-vétel nem mozdíthat 1000×-et egy egészséges párban) – az első érvénytelen pont = kiürülés
  let excluded = 0;
  for (const e of ents.values()) {
    e.path = e.path.filter((x) => (x.amt ?? 0) > 0);
    let bad = -1; for (let k = 1; k < e.path.length; k++) if (impliedReserve(e.path[k - 1]!.price, e.path[k]!.price, e.path[k]!.amt ?? 0) < minRes) { bad = k; break; }
    truncateAtRug(e, bad);
    // kizárás (ismeretlen adat, nem veszteség): kiürülés az első 60 mp-en belül, vagy a 60 mp-es pillanatkép-ár ≫ az addigi kötés-ár
    if (typeof e.m.ruggedAt === "number" && (e.m.ruggedAt as number) <= e.created + 60_000) { e.m.excluded = true; excluded++; }
  }
  let drained = 0;
  for (const r of db.prepare("SELECT pair, min_liq_bnb m FROM bnb_pair_outcomes WHERE min_liq_bnb IS NOT NULL AND min_liq_bnb < 0.05").iterate() as Iterable<{ pair: string; m: number }>) {
    const e = ents.get(r.pair); if (!e || !e.path.length || e.m.ruggedAt !== undefined || e.m.excluded) continue;
    drained++; const last = e.path[e.path.length - 1]!; e.path.push({ at: Math.min(last.at + 1, e.created + HORIZON), price: RUG_PRICE }); // a végén nyitva maradt pozíció nullát ér
  }
  // likviditás a belépés körül (a kötésekből visszaszámolt tartalék) – a riport bontásához
  for (const e of ents.values()) { let r = Infinity; for (let k = 1; k < e.path.length && e.path[k]!.at <= e.created + 90_000; k++) { const x = impliedReserve(e.path[k - 1]!.price, e.path[k]!.price, e.path[k]!.amt ?? 0); if (Number.isFinite(x)) r = x; } e.m.liqEntry = r; }
  const list = [...ents.values()].filter((e) => e.path.length >= 3 && !e.m.excluded);
  console.log(`B) a 24 órás kimenet szerint később kiürült (nyitott pozíció = 0): ${drained}`);
  console.log(`B) kizárt pár (kiürült az első percben): ${excluded}; eladhatatlan (≥10 vétel, 0 eladás): ${markHoneypots(list)}`);
  const liqMaxEarly = (e: Ent) => Math.max(sn(e, 30, "liq") ?? 0, sn(e, 60, "liq") ?? 0, sn(e, 180, "liq") ?? 0);
  const pullback = (e: Ent): Entry => { if (!((sn(e, 600, "liq") ?? 0) >= 0.8 * liqMaxEarly(e) && liqMaxEarly(e) > 0)) return null; let peak = 0; for (let i = 0; i < e.path.length; i++) { const x = e.path[i]!; peak = Math.max(peak, x.price); if (x.at >= e.created + 600_000 && x.price <= 0.6 * peak) return afterIdx(e, i, lat); } return null; };
  const breakout = (e: Ent): Entry => { if ((sn(e, 600, "ub") ?? 0) < 30) return null; let peak = 0, peakAt = 0; for (let i = 0; i < e.path.length; i++) { const x = e.path[i]!; if (x.price > peak) { if (x.at >= e.created + 600_000 && peakAt > 0 && peakAt < e.created + 600_000) return afterIdx(e, i, lat); peak = x.price; peakAt = x.at; } } return null; };
  const whale = (e: Ent): Entry => { for (let i = 0; i < e.path.length; i++) { const x = e.path[i]!; if (x.at >= e.created + 60_000 && x.side === "buy" && (x.amt ?? 0) >= 1) return afterIdx(e, i, lat); } return null; };
  const cands: Cand[] = [
    { name: "B0 véletlen 20% +60s", pick: (e) => (solRandomPick(e.id) ? atT(e, 60, lat, sn(e, 60, "price")) : null) },
    { name: "B1 minden +60s", pick: (e) => atT(e, 60, lat, sn(e, 60, "price")) },
    { name: "B2 minden +3p", pick: (e) => atT(e, 180, lat, sn(e, 180, "price")) },
    { name: "B3 minden +10p", pick: (e) => atT(e, 600, lat, sn(e, 600, "price")) },
    { name: "B4 minden +30p", pick: (e) => atT(e, 1800, lat, sn(e, 1800, "price")) },
    { name: "B5 liq ≥5 BNB és vevők ≥10 (+60s)", pick: (e) => ((sn(e, 60, "liq") ?? 0) >= 5 && (sn(e, 60, "ub") ?? 0) >= 10 ? atT(e, 60, lat, sn(e, 60, "price")) : null) },
    { name: "B6 router-indítás +60s", pick: (e) => (e.m.to === ROUTER ? atT(e, 60, lat, sn(e, 60, "price")) : null) },
    { name: "B7 egyéb indító (0xc9b7…) +60s", pick: (e) => (e.m.to === OTHER ? atT(e, 60, lat, sn(e, 60, "price")) : null) },
    { name: "B8 liq nő 30s→3p ≥1,2× és vevők ≥15 (+3p)", pick: (e) => (has(e, 30, 180) && sn(e, 180, "liq")! >= 1.2 * sn(e, 30, "liq")! && sn(e, 180, "ub")! >= 15 ? atT(e, 180, lat, sn(e, 180, "price")) : null) },
    { name: "B9 visszaesés (10p után −40% csúcstól, liq tart)", pick: pullback },
    { name: "B10 kitörés (új csúcs 10p után, ≥30 vevő)", pick: breakout },
    { name: "B11 túlélte az eladásokat +10p", pick: (e) => (has(e, 60, 600) && sn(e, 600, "sells")! >= 0.5 * sn(e, 600, "buys")! && sn(e, 600, "price")! >= sn(e, 60, "price")! ? atT(e, 600, lat, sn(e, 600, "price")) : null) },
    { name: "B12 rug-biztonság +10p (liq ≥80% a 30s-hez, vevők ≥20)", pick: (e) => (has(e, 30, 600) && sn(e, 600, "liq")! >= 0.8 * sn(e, 30, "liq")! && sn(e, 600, "ub")! >= 20 ? atT(e, 600, lat, sn(e, 600, "price")) : null) },
    { name: "B13 bálna-vétel ≥1 BNB (+60s után)", pick: whale },
    { name: "B14 nagy indulás (liq(30s) ≥20 BNB) +60s", pick: (e) => ((sn(e, 30, "liq") ?? 0) >= 20 ? atT(e, 60, lat, sn(e, 60, "price")) : null) },
  ];
  return { key: "B", title: "PancakeSwap-indítások (BNB)", ents: list, cands, latencyMs: lat, cost: BNB_COST, sizeNative: SIZE_USD / bnbUsd };
}

// ============ futtatás ============
const f = (x: number, d = 2) => (x >= 0 ? "+" : "") + x.toFixed(d);
const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / (a.length || 1);
const L: string[] = [`# Solana + BNB visszajátszás, harmadik kör – ${new Date().toISOString().slice(0, 16)} UTC`, "",
  `Horizont ${HORIZON / 3600_000} óra; belépő ${SIZE_USD} USD; kiszállási késés = belépési késés (a jelző kötés utáni első későbbi kötés árán); kiürült pool/pár és honeypot (≥10 vétel, 0 eladás) = 0 érték; SOL/USD ${solUsd.toFixed(2)}, BNB/USD ${bnbUsd.toFixed(2)}. Tervek: ${PLANS.join(", ")}. A tervet a tanítón választjuk, az ellenőrzőn jelentjük (90% CI). ✔ = tanító > 0 és ellenőrző CI alja > 0 és n ≥ 30.`, ""];
const summary: string[] = [];
const DEBUG = arg("--debug", ""), DEBUG_PLAN = arg("--debug-plan", "tp2_sl40");
const dbg: Array<{ id: string; created: number; at: number; price: number; net: number; reason: string; peakX: number; pts: number; hp: boolean; rug?: number }> = [];
let tests = 0;
const dsList: Ds[] = [];
for (const key of ONLY) {
  const ds = key === "A" ? loadAmm() : key === "S" ? loadSurvivors() : key === "B" ? loadBnb() : null; if (!ds) continue;
  dsList.push(ds);
  const sorted = ds.ents.sort((a, b) => a.created - b.created);
  const withSnaps = sorted.filter((e) => e.snaps.size > 0).length;
  console.log(`${ds.key}) időben helyes pillanatképpel: ${withSnaps} / ${sorted.length}`);
  const cut = sorted[Math.floor(sorted.length * 2 / 3)]?.created ?? 0;
  L.push(`## ${ds.key}) ${ds.title}`, "", `Entitások: ${sorted.length}; tanító/ellenőrző határ: ${new Date(cut).toISOString().slice(5, 16)} UTC; késés ${ds.latencyMs / 1000} mp; költség ${ds.cost.fee_pct}% + ${ds.cost.mev_pct}% MEV + ${ds.cost.tx_sol} natív/tx.`, "",
    "| Jelölt | n tanító | tanító (legjobb terv) | n ellenőrző | ellenőrző | 90% CI | nyitva a végén | live terv (ellenőrző) | |", "|---|---|---|---|---|---|---|---|---|");
  const rugged = sorted.filter((e) => typeof e.m.ruggedAt === "number").length;
  summary.push(`\n${ds.key}) ${ds.title} – ${sorted.length} entitás, ebből kiürült a horizonton belül: ${rugged} (${Math.round(100 * rugged / sorted.length)}%)`);
  L.push(`Kiürült (eladhatatlan) a horizonton belül: ${rugged} (${Math.round(100 * rugged / sorted.length)}%).`, "");
  for (const c of ds.cands) {
    const res = new Map<string, { tr: number[]; te: number[]; open: number }>(PLANS.map((p) => [p, { tr: [], te: [], open: 0 }]));
    let picked = 0;
    for (const e of sorted) {
      const en = c.pick(e); if (!en || !(en.price > 0) || en.price === RUG_PRICE) continue;
      if (typeof e.m.ruggedAt === "number" && en.at >= (e.m.ruggedAt as number)) continue; // a kihúzás után nincs mit venni
      picked++;
      const path = e.path.filter((x) => x.at > en.at);
      for (const p of PLANS) {
        const r = replayPosition(en.price, en.at, path, p, ds.sizeNative, cfg, ds.cost, { exitLatencyMs: ds.latencyMs });
        if (DEBUG && c.name.startsWith(DEBUG) && p === DEBUG_PLAN) dbg.push({ id: e.id, created: e.created, at: en.at, price: en.price, net: r.net * SIZE_USD, reason: r.reason, peakX: r.peakX, pts: path.length, hp: !!e.m.honeypot, rug: e.m.ruggedAt as number | undefined });
        const b = res.get(p)!; (e.created < cut ? b.tr : b.te).push(r.net * SIZE_USD); if (r.openAtEnd && e.created >= cut) b.open++;
      }
    }
    tests += PLANS.length;
    if (!picked) { L.push(`| ${c.name} | 0 | – | 0 | – | – | – | – | |`); summary.push(`  ${c.name.padEnd(52)} nincs belépés`); continue; }
    const best = PLANS.map((p) => ({ p, m: mean(res.get(p)!.tr), n: res.get(p)!.tr.length })).sort((a, b) => b.m - a.m)[0]!;
    const te = res.get(best.p)!.te, ci = bootstrapCI(te), live = res.get("live")!.te;
    const ok = best.m > 0 && !!ci && ci[0] > 0 && te.length >= 30;
    const openPct = te.length ? Math.round(100 * res.get(best.p)!.open / te.length) : 0;
    L.push(`| ${c.name} | ${best.n} | ${f(best.m)} (${best.p}) | ${te.length} | ${f(mean(te))} | ${ci ? `[${f(ci[0])}; ${f(ci[1])}]` : "–"} | ${openPct}% | ${live.length ? f(mean(live)) : "–"} | ${ok ? "✔" : ""} |`);
    summary.push(`  ${c.name.padEnd(52)} tanító n=${String(best.n).padStart(4)} ${f(best.m)} (${best.p.padEnd(10)}) | ellenőrző n=${String(te.length).padStart(4)} ${f(mean(te))} ${ci ? `[${f(ci[0])};${f(ci[1])}]` : ""} ${ok ? "✔" : ""}`);
    // részletes tervtábla a riportba
    L.push(`|   ↳ tervek (ellenőrző): ${PLANS.map((p) => { const x = res.get(p)!.te; return `${p} ${x.length ? f(mean(x)) : "–"}`; }).join(" · ")} |||||||||`);
  }
  L.push("");
}
if (dbg.length) {
  const by = new Map<string, number[]>(); for (const d of dbg) (by.get(d.reason) ?? by.set(d.reason, []).get(d.reason)!).push(d.net);
  console.log(`\nDEBUG ${DEBUG} / ${DEBUG_PLAN}: n=${dbg.length}, átlag ${f(mean(dbg.map((d) => d.net)))}`);
  for (const [r, v] of [...by].sort((a, b) => b[1].length - a[1].length)) console.log(`  ${r.padEnd(32)} n=${String(v.length).padStart(4)} átlag ${f(mean(v))} Σ${f(v.reduce((a, b) => a + b, 0))}`);
  console.log("  legnagyobb nyerők:"); for (const d of [...dbg].sort((a, b) => b.net - a.net).slice(0, 8)) console.log(`   ${d.id.slice(0, 12)} belépés ${new Date(d.at).toISOString().slice(5, 19)} @${d.price.toExponential(2)} → ${f(d.net)} (${d.reason}, csúcs ${d.peakX.toFixed(1)}x, ${d.pts} pont${d.hp ? ", honeypot" : ""}${d.rug ? ", kiürült" : ""})`);
  const liqOf = new Map<string, number>(); for (const ds of dsList) for (const e of ds.ents) if (typeof e.m.liqEntry === "number") liqOf.set(e.id, e.m.liqEntry as number);
  const bands: Array<[string, number, number]> = [["<0.5 BNB", 0, 0.5], ["0.5–2", 0.5, 2], ["2–10", 2, 10], ["10+", 10, Infinity], ["ismeretlen", Infinity, Infinity]];
  for (const [lab, lo, hi] of bands) { const v = dbg.filter((d) => { const l = liqOf.get(d.id) ?? Infinity; return lab === "ismeretlen" ? !Number.isFinite(l) : Number.isFinite(l) && l >= lo && l < hi; }).map((d) => d.net); if (v.length) console.log(`  likviditás ${lab.padEnd(10)} n=${String(v.length).padStart(4)} átlag ${f(mean(v))} Σ${f(v.reduce((a, b) => a + b, 0))}`); }
  const hist = [0.5, 1, 1.5, 2, 3, 5, 10].map((x) => `≥${x}x: ${Math.round(100 * dbg.filter((d) => d.peakX >= x).length / dbg.length)}%`).join("  ");
  console.log("  csúcs-eloszlás:", hist);
}
L.push(`Összes teszt: ${tests} (jelölt × terv) – 5%-os szinten ~${Math.round(tests * 0.05)} hamis pozitív várható véletlenül; a ✔ egy cellában nem bizonyíték, a jelölt-család iránya számít.`);
fs.mkdirSync("reports", { recursive: true });
const out = `reports/solbnb_${new Date().toISOString().slice(0, 10)}.md`; fs.writeFileSync(out, L.join("\n"));
console.log(summary.join("\n")); console.log(`\nÖsszes teszt: ${tests}; riport: ${out}`);
