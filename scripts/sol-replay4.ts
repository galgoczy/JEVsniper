/**
 * Solana negyedik kör (2026-10-14, előre rögzítve: docs/FELTETELEZESEK.md): a Base csalásszűrt `base_uni_hold`
 * megfelelője a Pump.fun-görbén, „tiszta” tokeneken. npm run sol:replay4 [-- --latency-sec 2] [-- --since 2026-10-14T06:36Z]
 * --since: csak az ezután indult tokenek eredménye (a farm-előzmény a korábbi adatból is számol) – 10-14 óta a H3 figyelésre
 * félretéve (a felhasználó kérésére); a rendszeres ellenőrzésnél ezzel nézzük a friss, független adaton.
 * Két menet: (1) az első 30 mp vételei időrendben → vevőszámok, csomagolás, farm-tárca arány (csak belépés előtti adat);
 * (2) a kiválasztott tokenek ár-útvonala (indexelt lekérdezés tokenenként) → visszajátszás a meglévő motorral.
 */
import fs from "node:fs";
import { loadConfig } from "../src/config.js";
import { openDb } from "../src/db/index.js";
import { bootstrapCI } from "../src/report/index.js";
import { replayPosition, solRandomPick, type PricePoint } from "../src/sol/replay.js";

const cfg = loadConfig();
const db = openDb(cfg.db.path);
const j = process.argv.indexOf("--latency-sec"); const latencyMs = 1000 * Number(j >= 0 ? process.argv[j + 1] : 2);
const solUsd = Number((db.prepare("SELECT value FROM meta WHERE key='sol_usd'").get() as { value: string } | undefined)?.value ?? 0);
if (!(solUsd > 0)) { console.log("❌ nincs SOL/USD ár"); process.exit(1); }
const sizeSol = 1 / solUsd;
const RING_MIN = 20, DAY = 86_400_000;
const si = process.argv.indexOf("--since"); const SINCE = si >= 0 ? Date.parse(process.argv[si + 1]!) : 0;

type Tok = { mint: string; created: number; creator: string; prior: number; ub15: Set<string>; ub30: Set<string>; firstSec: number; ring: number; snap30?: Snap; snap60?: Snap };
type Snap = { ub: number; price: number; cs: number };
const toks = new Map<string, Tok>();
const byCreator = new Map<string, number>();
for (const r of db.prepare("SELECT mint, created_at, creator FROM sol_tokens WHERE quote_sol = 1 ORDER BY created_at").iterate() as Iterable<{ mint: string; created_at: number; creator: string }>) {
  const prior = byCreator.get(r.creator) ?? 0; byCreator.set(r.creator, prior + 1);
  toks.set(r.mint, { mint: r.mint, created: r.created_at, creator: r.creator, prior, ub15: new Set(), ub30: new Set(), firstSec: 0, ring: 0 });
}
for (const s of db.prepare("SELECT mint, window_sec w, unique_buyers ub, price, creator_sold cs FROM sol_snapshots WHERE window_sec IN (30, 60, 1800)").iterate() as Iterable<{ mint: string; w: number; ub: number; price: number; cs: number }>) {
  const t = toks.get(s.mint); if (!t) continue;
  if (s.w === 30) t.snap30 = { ub: s.ub, price: s.price, cs: s.cs }; else if (s.w === 60) t.snap60 = { ub: s.ub, price: s.price, cs: s.cs }; else (t as Tok & { full?: boolean }).full = true;
}
for (const [m, t] of toks) if (!(t as Tok & { full?: boolean }).full || !t.snap30 || !t.snap60) toks.delete(m);
console.error(`tokenek (teljes 30 perces követés): ${toks.size}`);

// 1. menet: az első 60 mp vételei (a 30 mp-es jelekhez ≤ 30 mp; a farm-arány a vevő SAJÁT vétele előtti 24 órából)
const early: Array<{ mint: string; at: number; user: string }> = [];
for (const r of db.prepare("SELECT mint, at, user FROM sol_trades WHERE side = 'buy'").iterate() as Iterable<{ mint: string; at: number; user: string }>) {
  const t = toks.get(r.mint); if (!t || r.at > t.created + 30_000 || r.user === t.creator) continue;
  early.push(r);
}
early.sort((a, b) => a.at - b.at);
console.error(`korai vételek: ${early.length}`);
const wHist = new Map<string, { times: number[]; mints: Set<string> }>();
const ringBuyers = new Map<string, Set<string>>();
for (const b of early) {
  const t = toks.get(b.mint)!;
  const h = wHist.get(b.user) ?? wHist.set(b.user, { times: [], mints: new Set() }).get(b.user)!;
  if (!t.ub30.has(b.user)) {
    while (h.times.length && h.times[0]! < b.at - DAY) h.times.shift();
    if (h.times.length >= RING_MIN) (ringBuyers.get(b.mint) ?? ringBuyers.set(b.mint, new Set()).get(b.mint)!).add(b.user);
    h.times.push(b.at);
  }
  t.ub30.add(b.user); if (b.at <= t.created + 15_000) t.ub15.add(b.user);
  if (b.at <= t.created + 1_000) t.firstSec++;
}
early.length = 0;
for (const t of toks.values()) t.ring = t.ub30.size ? (ringBuyers.get(t.mint)?.size ?? 0) / t.ub30.size : 0;

const accel30 = (t: Tok) => { const a = t.ub15.size, b = t.ub30.size - a; return a > 0 ? b / a : b > 0 ? 9 : 0; };
const clean = (t: Tok, maxRing = 0.5) => t.firstSec <= 1 && t.snap30!.cs === 0 && t.prior === 0 && t.ring < maxRing;
const hold30 = (t: Tok) => t.ub30.size >= 10 && t.ub30.size < 30 && accel30(t) >= 2;
const CANDS: Array<{ name: string; w: 30 | 60; pick: (t: Tok) => boolean }> = [
  { name: "K0 véletlen 5% (30s)", w: 30, pick: (t) => solRandomPick(t.mint, 0.05) },
  { name: "K1 minden token (30s)", w: 30, pick: () => true },
  { name: "H1 hold (30s)", w: 30, pick: hold30 },
  { name: "H2 hold + tiszta", w: 30, pick: (t) => hold30(t) && clean(t) },
  { name: "H3 hold + tiszta, farm<20%", w: 30, pick: (t) => hold30(t) && clean(t, 0.2) },
  { name: "H4 tiszta + vevők≥10 (30s)", w: 30, pick: (t) => t.ub30.size >= 10 && clean(t) },
  { name: "H5 hold 60s + tiszta", w: 60, pick: (t) => t.snap60!.ub >= 10 && t.snap60!.ub < 30 && t.snap30!.ub > 0 && t.snap60!.ub / t.snap30!.ub >= 2 && t.snap60!.cs === 0 && clean(t) },
];
const sel = new Map<string, Array<{ c: number; t: Tok }>>();
for (const [m, t] of toks) if (t.created < SINCE) { toks.delete(m); continue; }
CANDS.forEach((c, i) => { if (i === 1) return; for (const t of toks.values()) if (c.pick(t)) (sel.get(t.mint) ?? sel.set(t.mint, []).get(t.mint)!).push({ c: i, t }); });
console.error(`útvonal-lekérés: ${sel.size} token`);
const q = db.prepare("SELECT at, price FROM sol_trades WHERE mint = ? ORDER BY at");
const res: Array<Array<{ created: number; plan: string; net: number }>> = CANDS.map(() => []);
const PLANS = ["live", "C"];
const entry = (t: Tok, w: number, path: PricePoint[]) => {
  const at = t.created + w * 1000, snapP = (w === 30 ? t.snap30 : t.snap60)!.price;
  if (!(snapP > 0)) return null;
  const moved = path.some((z) => z.at > at && z.at < at + latencyMs);
  const y = moved ? path.find((z) => z.at >= at + latencyMs) : undefined;
  return y ? { at: y.at, price: y.price } : { at: at + latencyMs, price: snapP };
};
let k = 0;
for (const [mint, list] of sel) {
  const path = q.all(mint) as PricePoint[];
  for (const { c, t } of list) { const e = entry(t, CANDS[c]!.w, path); if (!e) continue; for (const plan of PLANS) res[c]!.push({ created: t.created, plan, net: replayPosition(e.price, e.at, path, plan, sizeSol, cfg).net }); }
  if (++k % 20000 === 0) console.error(`  ${k}/${sel.size}`);
}
// K1 (minden token) – a véletlen mintából nem becsülhető pontosan, ezért 20%-os mintán (determinisztikus)
for (const t of toks.values()) if (solRandomPick(t.mint, 0.2) && !sel.has(t.mint)) { const path = q.all(t.mint) as PricePoint[]; const e = entry(t, 30, path); if (e) for (const plan of PLANS) res[1]!.push({ created: t.created, plan, net: replayPosition(e.price, e.at, path, plan, sizeSol, cfg).net }); }
for (const [mint, list] of sel) { const t = list[0]!.t; if (!solRandomPick(mint, 0.2)) continue; const path = q.all(mint) as PricePoint[]; const e = entry(t, 30, path); if (e) for (const plan of PLANS) res[1]!.push({ created: t.created, plan, net: replayPosition(e.price, e.at, path, plan, sizeSol, cfg).net }); }

const sorted = [...toks.values()].map((t) => t.created).sort((a, b) => a - b);
const cut = sorted[Math.floor(sorted.length * 2 / 3)]!;
const f = (x: number, d = 3) => (Number.isFinite(x) ? (x >= 0 ? "+" : "") + x.toFixed(d) : "-");
const m = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const ci = (xs: number[]) => { const c = bootstrapCI(xs); return c ? `${f(c[0], 2)}…${f(c[1], 2)}` : "-"; };
const L = [`# Solana 4. kör – a Base „uni hold” megfelelője tiszta tokeneken – ${new Date().toISOString().slice(0, 16)} UTC`, "",
  `Tokenek: ${toks.size} (SOL-páros, teljes 30 perces követés), ${new Date(sorted[0]!).toISOString().slice(0, 10)} – ${new Date(sorted.at(-1)!).toISOString().slice(0, 10)}; tanító/ellenőrző határ ${new Date(cut).toISOString().slice(5, 16)} UTC. Késés ${latencyMs / 1000} mp, 1 USD belépő, költségek mint korábban (Pump 1,25% + MEV 0,3% irányonként + 0,0001 SOL/tx). K1 = 20%-os minta.`, "",
  "| jelölt | terv | tanító n | átlag | 90% CI | ellenőrző n | átlag | 90% CI |", "|---|---|---|---|---|---|---|---|"];
CANDS.forEach((c, i) => { for (const plan of PLANS) { const r = res[i]!.filter((x) => x.plan === plan); const tr = r.filter((x) => x.created < cut).map((x) => x.net), te = r.filter((x) => x.created >= cut).map((x) => x.net); L.push(`| ${c.name} | ${plan} | ${tr.length} | ${f(m(tr))} | ${ci(tr)} | ${te.length} | ${f(m(te))} | ${ci(te)} |`); } });
// napi bontás a H-jelöltekre (live)
L.push("", "Napi átlag (live terv):", "", "| jelölt | " + [...new Set(sorted.map((x) => new Date(x).toISOString().slice(5, 10)))].join(" | ") + " |");
const days = [...new Set(sorted.map((x) => new Date(x).toISOString().slice(5, 10)))];
L.push("|---|" + days.map(() => "---").join("|") + "|");
CANDS.forEach((c, i) => { const r = res[i]!.filter((x) => x.plan === "live"); L.push(`| ${c.name} | ` + days.map((d) => { const xs = r.filter((x) => new Date(x.created).toISOString().slice(5, 10) === d).map((x) => x.net); return xs.length ? `${f(m(xs), 2)} (${xs.length})` : "-"; }).join(" | ") + " |"); });
const out = L.join("\n"); console.log(out);
fs.mkdirSync(cfg.report.output_dir, { recursive: true });
const file = `${cfg.report.output_dir}/sol_4kor_${new Date().toISOString().slice(0, 10)}${SINCE ? "_since" : ""}.md`; fs.writeFileSync(file, out); console.log(`\n✅ mentve: ${file}`);
db.close();
