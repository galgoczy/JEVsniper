import { parseAbi } from "viem";

// Uniswap v4 periphery (v4-periphery / universal-router), stabil szignatúrák.
export const universalRouterAbi = parseAbi([
  "function execute(bytes commands, bytes[] inputs, uint256 deadline) payable",
]);
export const v4QuoterAbi = parseAbi([
  "struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }",
  "struct QuoteExactSingleParams { PoolKey poolKey; bool zeroForOne; uint128 exactAmount; bytes hookData; }",
  "function quoteExactInputSingle(QuoteExactSingleParams params) returns (uint256 amountOut, uint256 gasEstimate)",
]);
export const permit2Abi = parseAbi([
  "function approve(address token, address spender, uint160 amount, uint48 expiration)",
  "function allowance(address owner, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)",
]);
export const erc20WriteAbi = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
]);
// PONS v2 factory: getLaunchedToken(token) – fázis, curve, pool-paraméterek (pons-sdk factoryAbi)
export const ponsFactoryReadAbi = parseAbi([
  "struct LaunchedToken { address token; address curve; address deployer; address pairToken; uint256 launchConfigId; uint8 phase; uint24 poolFee; int24 tickSpacing; uint16 creatorTaxBps; }",
]);

/** Universal Router parancsok és v4 akciók (universal-router Commands.sol, v4-periphery Actions.sol). */
export const UR_COMMAND_V4_SWAP = 0x10;
export const UR_COMMAND_SWEEP = 0x04;
export const V4_ACTION_SWAP_EXACT_IN_SINGLE = 0x06;
export const V4_ACTION_SETTLE_ALL = 0x0c;
export const V4_ACTION_TAKE_ALL = 0x0f;
