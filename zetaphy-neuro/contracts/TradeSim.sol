// SPDX-License-Identifier: MIT
// Neuro trade simulation (honeypot check). NEVER deployed: Neuro places this
// code at a throwaway address inside ONE eth_call (a "state override"), so
// nothing is signed, sent or stored on any chain. Inside that call it buys a
// little of a token through a Uniswap-V2-style router, sells it straight
// back, and reports what came out against what the router quoted.
//
// Compiled into src/tradesim.generated.js by `npm run tradesim`
// (test/tradesim.test.js fails if the two drift apart).
pragma solidity 0.8.26;

interface IV2Router {
    function factory() external view returns (address);
    function WETH() external view returns (address);
    function getAmountsOut(uint256 amountIn, address[] calldata path) external view returns (uint256[] memory);
    function swapExactETHForTokensSupportingFeeOnTransferTokens(uint256 amountOutMin, address[] calldata path, address to, uint256 deadline) external payable;
    function swapExactTokensForETHSupportingFeeOnTransferTokens(uint256 amountIn, uint256 amountOutMin, address[] calldata path, address to, uint256 deadline) external;
}

contract TradeSim {
    // Where the run stopped.
    uint8 constant BAD_ROUTER = 1;   // router's factory() or WETH() is not what Neuro expects
    uint8 constant NO_LIQUIDITY = 2; // the router quotes nothing for the buy
    uint8 constant BUY_FAILED = 3;   // the buy reverted
    uint8 constant SELL_FAILED = 4;  // bought, but approve or the sell reverted (or nothing was bought)
    uint8 constant DONE = 5;         // bought and sold

    struct Result {
        uint8 stage;
        uint256 expectedBuy;  // tokens the router quoted for amountIn
        uint256 bought;       // tokens that actually arrived
        uint256 expectedSell; // native coin the router quoted for the tokens sold
        uint256 sold;         // native coin that actually arrived
        uint256 buyGas;
        uint256 sellGas;
    }

    receive() external payable {}

    /// Never reverts on the token's account: every step that touches the
    /// token is wrapped, so a honeypot shows up as a stage, not an error.
    function run(address router, address factory, address weth, address token, uint256 amountIn)
        external
        returns (Result memory r)
    {
        IV2Router R = IV2Router(router);
        if (_addr(router, IV2Router.factory.selector) != factory || _addr(router, IV2Router.WETH.selector) != weth) {
            r.stage = BAD_ROUTER;
            return r;
        }

        address[] memory path = new address[](2);
        path[0] = weth;
        path[1] = token;
        r.expectedBuy = _quote(R, amountIn, path);
        if (r.expectedBuy == 0) {
            r.stage = NO_LIQUIDITY;
            return r;
        }

        uint256 before = _balance(token);
        uint256 g = gasleft();
        try R.swapExactETHForTokensSupportingFeeOnTransferTokens{value: amountIn}(0, path, address(this), block.timestamp) {
            r.buyGas = g - gasleft();
        } catch {
            r.stage = BUY_FAILED;
            return r;
        }
        uint256 afterBuy = _balance(token);
        r.bought = afterBuy > before ? afterBuy - before : 0;
        r.stage = SELL_FAILED;
        if (r.bought == 0) return r;

        // Sell 99%: a few tokens refuse to send a wallet's entire balance,
        // which is a nuisance, not a honeypot.
        uint256 amount = r.bought - r.bought / 100;
        path[0] = token;
        path[1] = weth;
        r.expectedSell = _quote(R, amount, path);
        if (!_approve(token, router, amount)) return r;
        uint256 ethBefore = address(this).balance;
        g = gasleft();
        try R.swapExactTokensForETHSupportingFeeOnTransferTokens(amount, 0, path, address(this), block.timestamp) {
            r.sellGas = g - gasleft();
            r.sold = address(this).balance - ethBefore;
            r.stage = DONE;
        } catch {}
    }

    function _quote(IV2Router R, uint256 amountIn, address[] memory path) private view returns (uint256) {
        try R.getAmountsOut(amountIn, path) returns (uint256[] memory a) {
            return a.length == 2 ? a[1] : 0;
        } catch {
            return 0;
        }
    }

    function _addr(address target, bytes4 selector) private view returns (address) {
        (bool ok, bytes memory ret) = target.staticcall(abi.encodeWithSelector(selector));
        if (!ok || ret.length != 32) return address(0);
        return abi.decode(ret, (address));
    }

    function _balance(address token) private view returns (uint256) {
        (bool ok, bytes memory ret) = token.staticcall(abi.encodeWithSelector(0x70a08231, address(this)));
        if (!ok || ret.length < 32) return 0;
        return abi.decode(ret, (uint256));
    }

    // Tolerates tokens whose approve returns nothing (USDT style).
    function _approve(address token, address spender, uint256 amount) private returns (bool) {
        (bool ok, bytes memory ret) = token.call(abi.encodeWithSelector(0x095ea7b3, spender, amount));
        if (!ok) return false;
        if (ret.length == 0) return true;
        return ret.length >= 32 && abi.decode(ret, (uint256)) != 0;
    }
}
