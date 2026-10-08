/**
 * Listázási források.
 *  Coinbase Exchange (hivatalos, nyilvános, kulcs nélkül): GET https://api.exchange.coinbase.com/currencies és /products.
 *    A mezőneveket a ccxt coinbaseexchange implementációja alapján ellenőriztük (id, supported_networks[].id/contract_address,
 *    status; products: id, base_currency, quote_currency, status, trading_disabled, auction_mode). Base hálózat id-je: "base".
 *  Robinhood (NEM hivatalos): GET https://nummus.robinhood.com/currency_pairs/ – a hivatalos Crypto Trading API saját
 *    kulcsot és amerikai fiókot kér; ez a nyilvános végpont több nyílt forrású kliensben dokumentált, de bármikor
 *    megváltozhat. Szerződéscímet nem ad, csak szimbólumot → a címet a DexScreenerből oldjuk fel.
 *  DexScreener (hivatalos, nyilvános, 300 kérés/perc): /latest/dex/tokens/{címek} és /latest/dex/search?q=.
 */
export type Fetch = typeof fetch;

async function getJson(f: Fetch, url: string, headers: Record<string, string> = {}): Promise<unknown> {
  const r = await f(url, { headers: { accept: "application/json", "user-agent": "jev-sniper/0.1", ...headers }, signal: AbortSignal.timeout(15_000) });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
  return r.json();
}
const str = (v: unknown) => (typeof v === "string" ? v : null);

export interface CbCurrency { id: string; name: string | null; status: string | null; baseContract: string | null }
export interface CbProduct { id: string; base: string; quote: string; tradable: boolean }

export async function coinbaseCurrencies(f: Fetch): Promise<CbCurrency[]> {
  const j = await getJson(f, "https://api.exchange.coinbase.com/currencies");
  if (!Array.isArray(j)) throw new Error("coinbase currencies: nem lista");
  return j.map((c: Record<string, unknown>) => {
    const nets = Array.isArray(c.supported_networks) ? (c.supported_networks as Array<Record<string, unknown>>) : [];
    const base = nets.find((n) => str(n.id) === "base" || (str(n.crypto_address_link) ?? "").includes("basescan.org"));
    const addr = base ? str(base.contract_address) : null;
    return { id: String(c.id), name: str(c.name), status: str(c.status), baseContract: addr && /^0x[0-9a-fA-F]{40}$/.test(addr) ? addr : null };
  });
}

export async function coinbaseProducts(f: Fetch): Promise<CbProduct[]> {
  const j = await getJson(f, "https://api.exchange.coinbase.com/products");
  if (!Array.isArray(j)) throw new Error("coinbase products: nem lista");
  return j.map((p: Record<string, unknown>) => ({ id: String(p.id), base: String(p.base_currency), quote: String(p.quote_currency),
    tradable: str(p.status) === "online" && p.trading_disabled !== true }));
}

export interface RhPair { key: string; code: string; name: string | null; tradable: boolean }
export async function robinhoodPairs(f: Fetch): Promise<RhPair[]> {
  const j = (await getJson(f, "https://nummus.robinhood.com/currency_pairs/")) as { results?: unknown };
  if (!Array.isArray(j.results)) throw new Error("robinhood currency_pairs: nincs results lista");
  return (j.results as Array<Record<string, unknown>>).map((p) => {
    const ac = (p.asset_currency ?? {}) as Record<string, unknown>;
    const code = str(ac.code) ?? String(str(p.symbol) ?? "").split("-")[0] ?? "";
    return { key: String(p.id ?? p.symbol ?? code), code, name: str(ac.name) ?? str(p.name), tradable: str(p.tradability) === "tradable" };
  }).filter((p) => p.code);
}

export interface DexPair { chainId: string; dexId: string; pairAddress: string; baseAddress: string; baseSymbol: string; priceUsd: number | null; liqUsd: number | null }
function parsePairs(j: unknown): DexPair[] {
  const pairs = (j as { pairs?: unknown }).pairs;
  if (!Array.isArray(pairs)) return [];
  return (pairs as Array<Record<string, unknown>>).map((p) => {
    const bt = (p.baseToken ?? {}) as Record<string, unknown>, lq = (p.liquidity ?? {}) as Record<string, unknown>;
    const price = Number(p.priceUsd), liq = Number(lq.usd);
    return { chainId: String(p.chainId), dexId: String(p.dexId), pairAddress: String(p.pairAddress), baseAddress: String(bt.address ?? ""), baseSymbol: String(bt.symbol ?? ""),
      priceUsd: Number.isFinite(price) && price > 0 ? price : null, liqUsd: Number.isFinite(liq) ? liq : null };
  });
}
/** Tokenenként a legnagyobb likviditású pár (a token az alap-oldalon). Legfeljebb 30 cím egy kérésben. */
export async function dexTokens(f: Fetch, addresses: string[]): Promise<Map<string, DexPair>> {
  const out = new Map<string, DexPair>();
  for (let i = 0; i < addresses.length; i += 30) {
    const chunk = addresses.slice(i, i + 30);
    const pairs = parsePairs(await getJson(f, `https://api.dexscreener.com/latest/dex/tokens/${chunk.join(",")}`));
    for (const p of pairs) {
      const k = p.baseAddress.toLowerCase();
      if (!chunk.some((a) => a.toLowerCase() === k) || p.priceUsd === null) continue;
      const cur = out.get(k);
      if (!cur || (p.liqUsd ?? 0) > (cur.liqUsd ?? 0)) out.set(k, p);
    }
  }
  return out;
}
export async function dexSearch(f: Fetch, q: string): Promise<DexPair[]> {
  return parsePairs(await getJson(f, `https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(q)}`));
}
