import { createPublicClient, http, defineChain, type Chain, type PublicClient } from "viem";
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
});

export const CHAINS: Record<ChainKey, Chain> = { base, robinhood: robinhoodChain };

export function publicClient(key: ChainKey, rpcUrl: string): PublicClient {
  return createPublicClient({ chain: CHAINS[key], transport: http(rpcUrl, { timeout: 10_000 }) });
}
