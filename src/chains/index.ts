import { createPublicClient, http, fallback, defineChain, type Chain, type PublicClient } from "viem";
import { base } from "viem/chains";

export type ChainKey = "base" | "robinhood";

/**
 * Robinhood Chain – Arbitrum Orbit L2, chain id 4663, gas ETH-ben.
 * Forrás: robinhoodchain.blockscout.com, rpc.mainnet.chain.robinhood.com (2026-07 mainnet).
 * A viem beépítve nem ismeri, ezért itt definiáljuk.
 */
export const robinhoodChain: Chain = defineChain({
  id: 4663,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.mainnet.chain.robinhood.com"] } },
  blockExplorers: { default: { name: "Blockscout", url: "https://robinhoodchain.blockscout.com" } },
  // Multicall3 genesis-deploy a kanonikus címen (multicall3.com lista, Robinhood Chain 4663)
  contracts: { multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" } },
});

export const CHAINS: Record<ChainKey, Chain> = { base, robinhood: robinhoodChain };

/** Vesszővel elválasztott URL-lista → tömb. */
export const rpcUrls = (list: string) => list.split(",").map((u) => u.trim()).filter(Boolean);

/**
 * Publikus kliens. Több URL esetén sorrendben próbálja őket: ha az első elutasít (429, hiba,
 * időtúllépés), a következőre vált, és később visszatér az elsőre. Így több ingyenes publikus
 * végpont kerete adódik össze, kulcs nélkül.
 */
export function publicClient(key: ChainKey, rpcUrl: string): PublicClient {
  const urls = rpcUrls(rpcUrl);
  const transports = urls.map((u) => http(u, { timeout: 10_000, retryCount: 1, retryDelay: 300 }));
  const transport = transports.length === 1 ? transports[0]! : fallback(transports, { rank: false, retryCount: 0 });
  return createPublicClient({ chain: CHAINS[key], transport });
}
