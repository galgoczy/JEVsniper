import type { Address } from "viem";
import type { ChainKey } from "./index.js";

/**
 * Szerződéscímek láncenként. Minden címhez forrás. Kitalált cím NINCS.
 * A verify:step2 script on-chain is ellenőrzi, hogy a címeken van kód és jönnek az események.
 */
export const ZERO: Address = "0x0000000000000000000000000000000000000000";

export const ADDRESSES: Record<ChainKey, {
  weth: Address;
  clankerV4Factory?: Address;
  ponsV2Factory?: Address;
  ponsV2Hook?: Address;
  uniswapV2Factory?: Address;
  uniswapV3Factory?: Address;
  uniswapV4PoolManager?: Address;
  chainlinkEthUsd?: Address;
  universalRouter?: Address;
  v4Quoter?: Address;
  permit2?: Address;
}> = {
  base: {
    // OP-stack előre telepített WETH9 (Base docs)
    weth: "0x4200000000000000000000000000000000000006",
    // clanker-sdk 4.2.19 CLANKERS.clanker_v4.address; BaseScan "Clanker v4.0.0" verified
    clankerV4Factory: "0xE85A59c628F7d27878ACeB4bf3b35733630083a9",
    // BaseScan "Uniswap V2: Factory" / Uniswap docs Base deployments
    uniswapV2Factory: "0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6",
    // Uniswap docs v3 Base deployments; BaseScan "Uniswap V3: Pool Factory"
    uniswapV3Factory: "0x33128a8fC17869897dcE68Ed026d694621f6FDfD",
    // Uniswap v4 deployments (Base); BaseScan "Uniswap V4: Pool Manager"
    uniswapV4PoolManager: "0x498581fF718922c3f8e6A244956aF099B2652b2b",
    // Chainlink ETH/USD aggregátor Base-en (docs.chain.link price feed lista)
    chainlinkEthUsd: "0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70",
    // Uniswap v4 Base: BaseScan "Uniswap V4: Universal Router" / "Quoter" (docs.uniswap.org v4 deployments)
    universalRouter: "0x6fF5693b99212Da76ad316178A184AB56D299b43",
    v4Quoter: "0x0d5e0F971ED27FBfF6c2837bf31316121532048D",
    // Permit2 kanonikus cím (minden láncon ugyanaz)
    permit2: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
  },
  robinhood: {
    // Robinhood Chain WETH címét hivatalos forrásból még nem erősítettem meg → a v4 poolokban
    // a natív ETH a 0x0 cím (PONS isNativeQuote), ezért a figyelés WETH nélkül is működik.
    weth: ZERO,
    // clanker-sdk 4.2.19 CLANKERS.clanker_v4_robinhood.address
    clankerV4Factory: "0xD3f2cC1731b7Fd17f28798835C2E02f0a1839A94",
    // PONS v2: pons-sdk MAINNET_DEPLOYMENT + docs.ponsfamily.com/v2#contracts + Bitquery + ponscli (mind egyezik)
    ponsV2Factory: "0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e",
    ponsV2Hook: "0xe5e702641ea86f4ae6cc3cdaed2b886f976be044",
    // Uniswap v4 PoolManager Robinhood Chainen: pons-sdk MAINNET_DEPLOYMENT.addresses.poolManager (+ ponscli)
    uniswapV4PoolManager: "0x8366a39cc670b4001a1121b8f6a443a643e40951",
    // Uniswap v4 Robinhood Chain: Uniswap docs (2026-07-06 újratelepített Universal Router), Quoter egyezik a pons-sdk quoterrel
    universalRouter: "0x06afBA43fd06227fA663b0dAeCF536F6eaA6BF99",
    v4Quoter: "0x8Dc178eFB8111BB0973Dd9d722ebeFF267c98F94",
    permit2: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
  },
};
