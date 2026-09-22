import { parseAbi } from "viem";

// Uniswap v2/v3/v4 gyári események (hivatalos Uniswap szerződések, stabil szignatúrák).
export const uniswapV2FactoryAbi = parseAbi([
  "event PairCreated(address indexed token0, address indexed token1, address pair, uint256 allPairsLength)",
]);
export const uniswapV3FactoryAbi = parseAbi([
  "event PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool)",
]);
export const uniswapV4PoolManagerAbi = parseAbi([
  "event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)",
]);
export const erc20Abi = parseAbi([
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
]);
