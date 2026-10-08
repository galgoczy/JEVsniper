import { getAddress, type Address } from "viem";

/**
 * BNB Smart Chain (chain id 56) – címek forrással. Kitalált cím NINCS; a `npm run verify:bnb` on-chain ellenőrzi (kód van-e).
 */
export const BNB = {
  // Four.Meme hivatalos integrációs dok. (github.com/four-meme-community/fourmeme-docs, docs/integration-guide.md 2.1)
  tokenManager2: getAddress("0x5c952063c7fc8610FFDB798152D69F0B9550762b"),
  helper3: getAddress("0xF251F83e40a78868FcfA3FA4599Dad6494E46034"),
  // PancakeSwap developer docs (developer.pancakeswap.finance/contracts/v2/addresses)
  pancakeV2Factory: getAddress("0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73"),
  pancakeV2Router: getAddress("0x10ED43C718714eb63d5aA57B78B54704E256024E"),
  // a Router WETH() hívása on-chain (verify:bnb)
  wbnb: getAddress("0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c"),
  // Chainlink reference-data-directory feeds-bsc-mainnet: "BNB / USD" proxy (18 tizedes – on-chain decimals())
  chainlinkBnbUsd: getAddress("0xd5D290Fe2ae6b55F385ab9C14d2CeB91DD3d9022"),
} as const satisfies Record<string, Address>;

/** Publikus RPC: a bnbchain.org dataseed végpontjai nem adnak getLogs-ot; a publicnode igen, ~1,5 óra előzménnyel (archív kulcs nélkül). */
export const BNB_DEFAULT_RPC = "https://bsc-rpc.publicnode.com";
/** Nyugták (adó-méréshez): a BNB Chain hivatalos nyilvános végpontja (docs.bnbchain.org „BSC RPC Endpoints”); a publicnode a
 *  néhány óránál régebbi nyugtát csak személyes tokennel adja („Archive requests require a personal token”, 2026-10-07). */
export const BNB_RECEIPT_RPC = "https://bsc-dataseed.bnbchain.org";
