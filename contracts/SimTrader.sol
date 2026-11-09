// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
interface IRouter {
  function swapExactETHForTokensSupportingFeeOnTransferTokens(uint amountOutMin, address[] calldata path, address to, uint deadline) external payable;
  function swapExactTokensForETHSupportingFeeOnTransferTokens(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) external;
}
interface IERC20 { function balanceOf(address) external view returns (uint); function approve(address, uint) external returns (bool); }
/// Csak eth_call-ban, kód-felülírással használt segéd: a címünkön vétel → approve → teljes visszaeladás egyetlen szimulált hívásban.
/// stage: 1 vétel bukott, 2 nem jött token, 3 approve bukott, 4 eladás bukott, 5 siker.
contract SimTrader {
  function run(address router, address wbnb, address token) external payable returns (uint got, uint bnbBack, uint8 stage) {
    address[] memory p = new address[](2); p[0] = wbnb; p[1] = token;
    uint b0 = IERC20(token).balanceOf(address(this));
    try IRouter(router).swapExactETHForTokensSupportingFeeOnTransferTokens{value: msg.value}(0, p, address(this), block.timestamp + 60) {} catch { return (0, 0, 1); }
    got = IERC20(token).balanceOf(address(this)) - b0;
    if (got == 0) return (0, 0, 2);
    try IERC20(token).approve(router, type(uint).max) {} catch { return (got, 0, 3); }
    p[0] = token; p[1] = wbnb;
    uint e0 = address(this).balance;
    try IRouter(router).swapExactTokensForETHSupportingFeeOnTransferTokens(got, 0, p, address(this), block.timestamp + 60) {} catch { return (got, 0, 4); }
    return (got, address(this).balance - e0, 5);
  }
  receive() external payable {}
}
