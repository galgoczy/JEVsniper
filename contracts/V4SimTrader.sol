// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
interface IERC20 { function balanceOf(address) external view returns (uint); function approve(address, uint) external returns (bool); }
interface IUniversalRouter { function execute(bytes calldata commands, bytes[] calldata inputs, uint256 deadline) external payable; }
interface IPermit2 { function approve(address token, address spender, uint160 amount, uint48 expiration) external; }
struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }
struct ExactInputSingleParams { PoolKey poolKey; bool zeroForOne; uint128 amountIn; uint128 amountOutMinimum; bytes hookData; }
/// Csak eth_call-ban, kód-felülírással használt segéd (Base, Uniswap v4, natív ETH-pár): UGYANAZ az út, mint az élő vétel –
/// Universal Router V4_SWAP (SWAP_EXACT_IN_SINGLE + SETTLE_ALL + TAKE_ALL) → approve(Permit2) → Permit2.approve(router) → eladás.
/// stage: 1 vétel bukott, 2 nem jött token, 3 approve bukott, 4 ELADÁS bukott, 5 siker.
contract V4SimTrader {
  uint8 constant UR_V4_SWAP = 0x10; uint8 constant SWAP_EXACT_IN_SINGLE = 0x06; uint8 constant SETTLE_ALL = 0x0c; uint8 constant TAKE_ALL = 0x0f;
  function run(address router, address permit2, PoolKey calldata key, address token, bool tokenIsC0) external payable returns (uint got, uint ethBack, uint8 stage) {
    uint b0 = IERC20(token).balanceOf(address(this));
    if (!_swap(router, key, !tokenIsC0, uint128(msg.value), address(0), token, msg.value)) return (0, 0, 1);
    got = IERC20(token).balanceOf(address(this)) - b0;
    if (got == 0) return (0, 0, 2);
    try IERC20(token).approve(permit2, type(uint).max) {} catch { return (got, 0, 3); }
    try IPermit2(permit2).approve(token, router, type(uint160).max, uint48(block.timestamp + 3600)) {} catch { return (got, 0, 3); }
    uint e0 = address(this).balance;
    if (!_swap(router, key, tokenIsC0, uint128(got), token, address(0), 0)) return (got, 0, 4);
    return (got, address(this).balance - e0, 5);
  }
  function _swap(address router, PoolKey calldata key, bool zfo, uint128 amountIn, address inCur, address outCur, uint value) internal returns (bool) {
    bytes[] memory params = new bytes[](3);
    params[0] = abi.encode(ExactInputSingleParams(key, zfo, amountIn, 0, ""));
    params[1] = abi.encode(inCur, uint256(amountIn));
    params[2] = abi.encode(outCur, uint256(0));
    bytes[] memory inputs = new bytes[](1);
    inputs[0] = abi.encode(abi.encodePacked(SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE_ALL), params);
    try IUniversalRouter(router).execute{value: value}(abi.encodePacked(UR_V4_SWAP), inputs, block.timestamp + 60) { return true; } catch { return false; }
  }
  receive() external payable {}
}
