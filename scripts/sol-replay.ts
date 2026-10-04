/**
 * Solana / Pump.fun visszajátszás: npm run sol:replay [-- --size-usd 1]
 * Előre rögzített jelöltek (2026-10-04, a felvétel ELŐTT leírva a felhasználónak): véletlen és „minden token” alapvonal;
 * „valódi vevők” (külső vevők + gyorsulás, a rule_v2/strict megfelelője); készítő-szűrő (a nofactory megfelelője);
 * gyors görbe-töltés (60 mp-nél ≥ 60%); görbe-átlépés 50% / 80% (pregrad). Kilépés: live, C, B (mint a Base-en).
 * Időrendi felosztás: a tokenek első 2/3-a „tanító”, utolsó 1/3-a „ellenőrző” – egy jelölt csak akkor érdekes, ha mindkettőn tart.
 * Késleltetés (--latency-sec, alapból 2): a jelzés utáni első, legalább ennyivel későbbi kötés árán lépünk be – 0 mp-nél a
 * jelző kötés árán „vennénk”, ami elérhetetlen (10-04: a görbe-átlépés 50% így hamisan nyereségesnek látszott).
 * Eredmény nettó USD / 1 USD (költségekkel). Csak olvas; a riport a reports/ mappába is íródik.
 */
import fs from "node:fs";
import { loadConfig } from "../src/config.js";
import { openDb } from "../src/db/index.js";
import { bootstrapCI } from "../src/report/index.js";
import { replayPosition, solRandomPick, SOL_COST, type PricePoint } from "../src/sol/replay.js";

const cfg = loadConfig();
const db = openDb(cfg.db.path);
const i = process.argv.indexOf("--size-usd"); const sizeUsd = Number(i >= 0 ? process.argv[i + 1] : 1);
// késleltetés: a jelzés után ennyi mp-cel későbbi első kötés árán lépünk be (a valóságban nem a jelző kötés árán veszünk)
const j = process.argv.indexOf("--latency-sec"); const latencyMs = 1000 * Number(j >= 0 ? process.argv[j + 1] : 2); // alapból 2 mp (10-04: 0 mp-nél a görbe-átlépés hamisan nyereséges volt)
const solUsd = Number((db.prepare("SELECT value FROM meta WHERE key='sol_usd'").get() as { value: string } | undefined)?.value ?? 0);
if (!(solUsd > 0)) { console.log("❌ nincs SOL/USD ár a meta táblában"); process.exit(1); }
const sizeSol = sizeUsd / solUsd;
const now = Date.now();

type Tok = { mint: string; created: number; creator: string; snaps: Map<number, { ub: number; buys: number; sells: number; solIn: number; solOut: number; price: number; prog: number; cs: number; cb: number }> };
const toks = new Map<string, Tok>();
for (const r of db.prepare(`SELECT t.mint, t.created_at, t.creator FROM sol_tokens t WHERE t.quote_sol = 1 AND t.created_at < ?`).iterate(now - 1800_000 - 60_000) as Iterable<{ mint: string; created_at: number; creator: string }>)
  toks.set(r.mint, { mint: r.mint, created: r.created_at, creator: r.creator, snaps: new Map() });
for (const s of db.prepare(`SELECT mint, window_sec w, unique_buyers ub, buys, sells, sol_in, sol_out, price, progress_pct prog, creator_sold cs, creator_bought cb FROM sol_snapshots`).iterate() as Iterable<{ mint: string; w: number; ub: number; buys: number; sells: number; sol_in: number; sol_out: number; price: number; prog: number; cs: number; cb: number }>) {
  const t = toks.get(s.mint); if (t) t.snaps.set(s.w, { ub: s.ub, buys: s.buys, sells: s.sells, solIn: s.sol_in, solOut: s.sol_out, price: s.price, prog: s.prog, cs: s.cs, cb: s.cb });
}
// csak a teljes 30 perces pillanatkép-sorozattal rendelkező tokenek (a felvevő végig látta őket)
for (const [m, t] of toks) if (!t.snaps.has(1800) || !t.snaps.has(60)) toks.delete(m);
// készítő-előzmény: hány korábbi tokenje volt (a felvétel kezdete óta)
const byCreator = new Map<string, number[]>();
for (const r of db.prepare("SELECT creator, created_at FROM sol_tokens ORDER BY created_at").iterate() as Iterable<{ creator: string; created_at: number }>) (byCreator.get(r.creator) ?? byCreator.set(r.creator, []).get(r.creator)!).push(r.created_at);
const priorTokens = (t: Tok) => (byCreator.get(t.creator) ?? []).filter((x) => x < t.created).length;
// ár-útvonalak (első 30 perc) + görbe-haladás
const paths = new Map<string, Array<PricePoint & { prog: number }>>();
for (const r of db.prepare("SELECT mint, at, price, progress_pct FROM sol_trades ORDER BY mint, at").iterate() as Iterable<{ mint: string; at: number; price: number; progress_pct: number }>) {
  if (!toks.has(r.mint)) continue; (paths.get(r.mint) ?? paths.set(r.mint, []).get(r.mint)!).push({ at: r.at, price: r.price, prog: r.progress_pct });
}
const sorted = [...toks.values()].sort((a, b) => a.created - b.created);
const cut = sorted[Math.floor(sorted.length * 2 / 3)]?.created ?? 0;

type Entry = { mint: string; at: number; price: number; created: number };
const atWindow = (t: Tok, w: number): Entry | null => {
  const s = t.snaps.get(w); if (!s || !(s.price > 0)) return null;
  const at = t.created + w * 1000;
  // késleltetett belépés: ha a [jelzés, jelzés + késleltetés] sávban kötés volt, az utána következő első kötés ára; különben a pillanatkép ára
  const p = paths.get(t.mint) ?? [];
  const moved = latencyMs > 0 && p.some((z) => z.at > at && z.at < at + latencyMs);
  const y = moved ? p.find((z) => z.at >= at + latencyMs) : undefined;
  return y ? { mint: t.mint, at: y.at, price: y.price, created: t.created } : { mint: t.mint, at: at + latencyMs, price: s.price, created: t.created };
};
const accel = (t: Tok, w: number, prev: number) => { const a = t.snaps.get(w)?.ub ?? 0, b = t.snaps.get(prev)?.ub ?? 0; return b > 0 ? a / b : a > 0 ? 9 : 0; };
const crossing = (t: Tok, level: number): Entry | null => {
  const p = paths.get(t.mint) ?? []; let prev = 0;
  for (let k = 0; k < p.length; k++) {
    const x = p[k]!;
    if (prev < level && x.prog >= level && x.prog < 100) {
      if (!latencyMs) return { mint: t.mint, at: x.at, price: x.price, created: t.created };
      const y = p.slice(k + 1).find((z) => z.at >= x.at + latencyMs); // késleltetett belépés: az első későbbi kötés ára
      return y && y.prog < 100 ? { mint: t.mint, at: y.at, price: y.price, created: t.created } : null;
    }
    prev = x.prog;
  }
  return null;
};

const CANDS: Array<{ name: string; pick: (t: Tok) => Entry | null }> = [
  { name: "véletlen (60s)", pick: (t) => (solRandomPick(t.mint) ? atWindow(t, 60) : null) },
  { name: "minden token (60s)", pick: (t) => atWindow(t, 60) },
  { name: "vevők≥3 (60s)", pick: (t) => ((t.snaps.get(60)?.ub ?? 0) >= 3 ? atWindow(t, 60) : null) },
  { name: "vevők≥10 (60s)", pick: (t) => ((t.snaps.get(60)?.ub ?? 0) >= 10 ? atWindow(t, 60) : null) },
  { name: "v2-szerű (60s)", pick: (t) => { const s = t.snaps.get(60)!; return s.ub >= 10 && accel(t, 60, 30) >= 1.2 && s.cs === 0 && priorTokens(t) === 0 ? atWindow(t, 60) : null; } },
  { name: "v2_strict-szerű (60s)", pick: (t) => { const s = t.snaps.get(60)!; return s.ub >= 10 && accel(t, 60, 30) >= 2 && s.cs === 0 && priorTokens(t) === 0 ? atWindow(t, 60) : null; } },
  { name: "v2_strict-szerű (180s)", pick: (t) => { const s = t.snaps.get(180); return s && s.ub >= 10 && accel(t, 180, 60) >= 1.2 && s.cs === 0 && priorTokens(t) === 0 ? atWindow(t, 180) : null; } },
  { name: "készítő tart + új készítő (60s)", pick: (t) => (t.snaps.get(60)!.cs === 0 && priorTokens(t) === 0 && (t.snaps.get(60)!.ub >= 3) ? atWindow(t, 60) : null) },
  { name: "gyors görbe ≥60% (60s)", pick: (t) => (t.snaps.get(60)!.prog >= 60 ? atWindow(t, 60) : null) },
  { name: "görbe-átlépés 50%", pick: (t) => crossing(t, 50) },
  { name: "görbe-átlépés 80%", pick: (t) => crossing(t, 80) },
];
const PLANS = ["live", "C", "B"];
const f = (x: number, d = 2) => (x >= 0 ? "+" : "") + x.toFixed(d);
const L: string[] = [`# Solana / Pump.fun visszajátszás – ${new Date().toISOString().slice(0, 16)} UTC`, "",
  `Tokenek: ${toks.size} (SOL-párosítás, teljes 30 perces követés); tanító/ellenőrző határ: ${new Date(cut).toISOString().slice(5, 16)} UTC. Belépő ${sizeUsd} USD = ${sizeSol.toFixed(5)} SOL (SOL/USD ${solUsd.toFixed(2)}).`,
  `Késleltetés a jelzés és a vétel között: ${latencyMs / 1000} mp (a jelzés utáni első, legalább ennyivel későbbi kötés árán lépünk be).`,
  `Költség: Pump-díj ${SOL_COST.fee_pct}% + MEV/csúszás ${SOL_COST.mev_pct}% irányonként, ${SOL_COST.tx_sol} SOL tranzakciónként. Útvonal: első 30 perc (max. 500 kötés/token); a végén nyitva maradt rész az utolsó áron.`, "",
  "| jelölt | terv | tanító n | átlag | 90% CI | ellenőrző n | átlag | 90% CI | nyitva a végén |", "|---|---|---|---|---|---|---|---|---|"];
for (const c of CANDS) {
  const entries = sorted.map(c.pick).filter((e): e is Entry => e !== null);
  for (const plan of PLANS) {
    const res = entries.map((e) => ({ e, r: replayPosition(e.price, e.at, paths.get(e.mint) ?? [], plan, sizeSol, cfg) }));
    const tr = res.filter((x) => x.e.created < cut).map((x) => x.r.net), te = res.filter((x) => x.e.created >= cut).map((x) => x.r.net);
    const m = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
    const ci = (xs: number[]) => { const c2 = bootstrapCI(xs); return c2 ? `${f(c2[0])}…${f(c2[1])}` : "-"; };
    const open = res.length ? Math.round(100 * res.filter((x) => x.r.openAtEnd).length / res.length) : 0;
    L.push(`| ${c.name} | ${plan} | ${tr.length} | ${f(m(tr), 3)} | ${ci(tr)} | ${te.length} | ${f(m(te), 3)} | ${ci(te)} | ${open}% |`);
  }
}
L.push("", "Olvasat: nettó USD 1 USD belépőre. Egy jelölt akkor érdekes, ha a tanító ÉS az ellenőrző részen is nulla fölötti az átlag, és a véletlen/minden-token alapvonalnál jobb. Sok kombinációt nézünk egyszerre – egy-egy jó sor véletlen is lehet; csak friss adaton (árnyékban) igazolva számít.");
const out = L.join("\n"); console.log(out);
fs.mkdirSync(cfg.report.output_dir, { recursive: true });
const file = `${cfg.report.output_dir}/sol_visszajatszas_${new Date().toISOString().slice(0, 10)}${latencyMs ? `_kesl${latencyMs / 1000}s` : ""}.md`; fs.writeFileSync(file, out); console.log(`\n✅ mentve: ${file}`);
db.close();
