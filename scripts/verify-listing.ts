/**
 * Listázás-figyelő verify: a valódi források elérhetősége és formátuma (csak olvas, semmit nem ment).
 * Futtatás: npm run verify:listing
 */
import { coinbaseCurrencies, coinbaseProducts, robinhoodPairs, dexTokens, dexSearch } from "../src/listing/sources.js";
import { loadConfig } from "../src/config.js";
const ok = (m: string) => console.log("✅", m);
const bad = (m: string) => { console.log("❌", m); process.exitCode = 1; };
const cfg = loadConfig();

try {
  const cur = await coinbaseCurrencies(fetch);
  const withBase = cur.filter((c) => c.baseContract);
  withBase.length ? ok(`Coinbase eszközök: ${cur.length}, ebből Base szerződéssel: ${withBase.length} (pl. ${withBase.slice(0, 3).map((c) => c.id).join(", ")})`) : bad(`Coinbase eszközök: ${cur.length}, de egyiknél sincs Base szerződés – a hálózat-azonosító eltér?`);
  const prod = await coinbaseProducts(fetch);
  ok(`Coinbase termékek: ${prod.length}, kereskedhető: ${prod.filter((p) => p.tradable).length}`);
  if (withBase.length) {
    const sample = withBase.find((c) => c.id !== "USDC") ?? withBase[0]!;
    const m = await dexTokens(fetch, [sample.baseContract!]);
    const p = m.get(sample.baseContract!.toLowerCase());
    p ? ok(`DexScreener ár: ${sample.id} ${p.priceUsd} USD, likviditás ${Math.round(p.liqUsd ?? 0)} USD (${p.chainId}/${p.dexId})`) : bad(`DexScreener: nincs pár ehhez: ${sample.id} ${sample.baseContract}`);
  }
} catch (e) { bad(`Coinbase/DexScreener hiba: ${(e as Error).message}`); }

try {
  const rh = await robinhoodPairs(fetch);
  rh.length ? ok(`Robinhood párok (nem hivatalos végpont): ${rh.length}, kereskedhető: ${rh.filter((p) => p.tradable).length} (pl. ${rh.slice(0, 5).map((p) => p.code).join(", ")})`) : bad("Robinhood: üres lista");
} catch (e) { bad(`Robinhood hiba (a nem hivatalos végpont nem érhető el innen?): ${(e as Error).message}`); }

try {
  const s = await dexSearch(fetch, "CASHCAT");
  const chains = [...new Set(s.map((p) => p.chainId))];
  const rhMatch = chains.filter((c) => c.toLowerCase().includes(cfg.listing.robinhood_chain_match));
  console.log(`   DexScreener keresés „CASHCAT”: láncok: ${chains.join(", ") || "-"}`);
  rhMatch.length ? ok(`Robinhood Chain azonosító a DexScreeneren: ${rhMatch.join(", ")} (illeszkedik a beállításhoz)`) : bad(`Nincs „${cfg.listing.robinhood_chain_match}” láncú találat – küldd el a fenti lánclistát, és beállítom a helyes azonosítót`);
} catch (e) { bad(`DexScreener keresés hiba: ${(e as Error).message}`); }
