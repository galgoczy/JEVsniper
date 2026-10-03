/** Egyszeri feltérképezés (csak olvas): Four.Meme forgalom-eloszlás a friss blokkokban. npm-szkript nélkül: npx tsx scripts/probe-bnb-activity.ts */
import { createPublicClient, http, decodeEventLog, getAddress } from "viem";
import { bsc } from "viem/chains";
import { fourMemeTokenManager2Abi } from "../src/abis/fourmeme.js";
const TM2 = getAddress("0x5c952063c7fc8610FFDB798152D69F0B9550762b");
const c = createPublicClient({ chain: bsc, transport: http(process.env.BNB_RPC_URL ?? "https://bsc-rpc.publicnode.com", { timeout: 15_000 }) });
const head = await c.getBlockNumber(); const span = 9500n;
type T = { buys: number; sells: number; buyers: Set<string>; vol: number; maxFunds: number; firstPrice: number; maxPrice: number; lastPrice: number; created: boolean; quote0: boolean };
const tok = new Map<string, T>();
const g = (a: string) => { let t = tok.get(a); if (!t) { t = { buys: 0, sells: 0, buyers: new Set(), vol: 0, maxFunds: 0, firstPrice: 0, maxPrice: 0, lastPrice: 0, created: false, quote0: true }; tok.set(a, t); } return t; };
for (let f = head - span; f <= head; f += 100n) {
  const logs = await c.getLogs({ address: TM2, fromBlock: f, toBlock: f + 99n > head ? head : f + 99n });
  for (const l of logs) {
    let d; try { d = decodeEventLog({ abi: fourMemeTokenManager2Abi, data: l.data, topics: l.topics }); } catch { continue; }
    const a = d.args as Record<string, any>;
    if (d.eventName === "TokenCreate") g(String(a.token).toLowerCase()).created = true;
    if (d.eventName === "TokenPurchase" || d.eventName === "TokenSale") {
      const t = g(String(a.token).toLowerCase()); const price = Number(a.price) / 1e18, funds = Number(a.funds) / 1e18;
      if (d.eventName === "TokenPurchase") { t.buys++; t.buyers.add(String(a.account)); t.vol += Number(a.cost) / 1e18; } else { t.sells++; t.vol += Number(a.cost) / 1e18; }
      if (!t.firstPrice) t.firstPrice = price; t.maxPrice = Math.max(t.maxPrice, price); t.lastPrice = price; t.maxFunds = Math.max(t.maxFunds, funds);
    }
  }
}
const all = [...tok.values()], created = all.filter((t) => t.created);
const b = (f: (t: T) => boolean, arr = created) => arr.filter(f).length;
console.log(`ablak ~${Number(span) * 0.45 / 60 | 0} perc; új token: ${created.length}; forgalmas token összesen (régebbiekkel): ${all.filter((t) => t.buys + t.sells > 0).length}`);
console.log(`új tokenek vevőszám szerint: 0 vevő ${b((t) => t.buyers.size === 0)}, 1 ${b((t) => t.buyers.size === 1)}, 2-4 ${b((t) => t.buyers.size >= 2 && t.buyers.size <= 4)}, 5-19 ${b((t) => t.buyers.size >= 5 && t.buyers.size < 20)}, 20+ ${b((t) => t.buyers.size >= 20)}`);
console.log(`összes forgalom: ${all.reduce((s, t) => s + t.vol, 0).toFixed(2)} BNB; görbe-haladás (max funds / 18 BNB) a forgalmas tokeneknél: >10% ${b((t) => t.maxFunds / 18 > 0.1, all)}, >50% ${b((t) => t.maxFunds / 18 > 0.5, all)}, >90% ${b((t) => t.maxFunds / 18 > 0.9, all)}`);
console.log(`ár-csúcs az első kereskedési árhoz: ≥2x ${b((t) => t.firstPrice > 0 && t.maxPrice / t.firstPrice >= 2, all)}, ≥5x ${b((t) => t.firstPrice > 0 && t.maxPrice / t.firstPrice >= 5, all)}, ≥10x ${b((t) => t.firstPrice > 0 && t.maxPrice / t.firstPrice >= 10, all)}`);
const top = all.filter((t) => t.buys > 0).sort((x, y) => y.vol - x.vol).slice(0, 8);
console.log("legforgalmasabb: " + top.map((t) => `${t.buyers.size} vevő/${t.vol.toFixed(2)} BNB/${(t.maxFunds / 18 * 100).toFixed(0)}%/${(t.maxPrice / t.firstPrice).toFixed(1)}x`).join(" | "));
