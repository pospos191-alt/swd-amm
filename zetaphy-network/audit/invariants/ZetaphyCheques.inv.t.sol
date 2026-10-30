// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {ZetaphyCheques} from "../../contracts/ZetaphyCheques.sol";
import {MockERC20} from "./utils/Mocks.sol";

/// Drives ZetaphyCheques with real EIP-712 cheques signed by vm.sign.
contract ChequesHandler is Test {
    ZetaphyCheques public c;
    MockERC20 public token;
    address[3] public payers = [address(0xA1), address(0xA2), address(0xA3)];
    address[3] public payees = [address(0xB1), address(0xB2), address(0xB3)];
    uint256[3] internal signerKeys = [uint256(0x51), uint256(0x52), uint256(0x53)];

    uint256[] public ids;
    mapping(uint256 => uint256) public signerOf;   // channel -> index into signerKeys
    // ghosts
    uint256 public ghostCashedNative;
    uint256 public ghostCashedToken;
    uint256 public ghostWithdrawnNative;
    uint256 public ghostWithdrawnToken;
    uint256 public ghostDepositNative;
    uint256 public ghostDepositToken;
    bool public cashAfterCloseSucceeded;   // must never happen
    bool public overpaid;                  // a cash that paid more than deposit - paid
    bool public withdrawWrong;             // payer got something other than deposit - paid
    bool public nonPayerMovedFunds;        // a non-payer topped up / withdrew / closed successfully
    mapping(bytes32 => uint256) public hits; // successful calls per action (coverage check)

    constructor(ZetaphyCheques c_, MockERC20 t) {
        c = c_;
        token = t;
        for (uint256 i; i < 3; i++) {
            vm.deal(payers[i], 1e30);
            token.mint(payers[i], 1e30);
            vm.prank(payers[i]);
            token.approve(address(c), type(uint256).max);
        }
    }

    function _ch(uint256 seed) internal view returns (uint256 id, bool ok) {
        if (ids.length == 0) return (0, false);
        return (ids[seed % ids.length], true);
    }

    function _sign(uint256 id, uint256 cumulative) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerKeys[signerOf[id]], c.chequeDigest(id, cumulative));
        return abi.encodePacked(r, s, v);
    }

    function open(uint256 payerSeed, uint256 payeeSeed, bool native, uint256 amount, uint64 dur, uint256 signerSeed) external {
        amount = bound(amount, 1, 1e24);
        dur = uint64(bound(dur, 1, 366 days));
        address payer = payers[payerSeed % 3];
        uint256 si = signerSeed % 3;
        vm.prank(payer);
        uint256 id = c.open{value: native ? amount : 0}(payees[payeeSeed % 3], native ? address(0) : address(token), amount,
            uint64(block.timestamp + dur), vm.addr(signerKeys[si]));
        ids.push(id);
        signerOf[id] = si;
        if (native) ghostDepositNative += amount; else ghostDepositToken += amount;
    }

    function topUp(uint256 seed, uint256 amount, uint256 callerSeed) external {
        (uint256 id, bool ok) = _ch(seed);
        if (!ok) return;
        amount = bound(amount, 1, 1e24);
        (address payer,,,, address tok,,,,) = c.channels(id);
        address caller = callerSeed % 4 == 0 ? payers[callerSeed % 3] : payer; // sometimes a stranger
        bool native = tok == address(0);
        vm.deal(caller, caller.balance + amount);
        vm.prank(caller);
        try c.topUp{value: native ? amount : 0}(id, amount) {
            if (caller != payer) nonPayerMovedFunds = true;
            if (native) ghostDepositNative += amount; else ghostDepositToken += amount;
        } catch {}
    }

    struct Ch { address payer; uint64 expiry; uint64 closeAt; address payee; address tok; uint256 deposit; uint256 paid; bool done; }

    function get(uint256 id) public view returns (Ch memory x) {
        (x.payer, x.expiry, x.closeAt, x.payee, x.tok,, x.deposit, x.paid, x.done) = c.channels(id);
    }

    function _bal(address tok, address who) internal view returns (uint256) {
        return tok == address(0) ? who.balance : token.balanceOf(who);
    }

    function cash(uint256 seed, uint256 cumulative) external {
        (uint256 id, bool ok) = _ch(seed);
        if (!ok) return;
        Ch memory x = get(id);
        cumulative = bound(cumulative, 0, x.deposit * 2 + 1);
        bytes memory sig = _sign(id, cumulative);
        bool closed = x.done || (x.closeAt != 0 && block.timestamp >= x.closeAt);
        uint256 before = _bal(x.tok, x.payee);
        try c.cash(id, cumulative, sig) returns (uint256 amount) {
            if (closed) cashAfterCloseSucceeded = true;
            if (amount > x.deposit - x.paid) overpaid = true;
            if (_bal(x.tok, x.payee) - before != amount) overpaid = true;
            if (x.tok == address(0)) ghostCashedNative += amount; else ghostCashedToken += amount;
            hits["cash"]++;
        } catch {}
    }

    function startClose(uint256 seed, uint256 callerSeed) external {
        (uint256 id, bool ok) = _ch(seed);
        if (!ok) return;
        (address payer,,,,,,,,) = c.channels(id);
        address caller = callerSeed % 4 == 0 ? payees[callerSeed % 3] : payer;
        vm.prank(caller);
        try c.startClose(id) { if (caller != payer) nonPayerMovedFunds = true; } catch {}
    }

    function release(uint256 seed) external {
        (uint256 id, bool ok) = _ch(seed);
        if (!ok) return;
        (,,, address payee,,,,,) = c.channels(id);
        vm.prank(payee);
        try c.release(id) {} catch {}
    }

    function withdraw(uint256 seed, uint256 callerSeed) external {
        (uint256 id, bool ok) = _ch(seed);
        if (!ok) return;
        Ch memory x = get(id);
        address caller = callerSeed % 4 == 0 ? payees[callerSeed % 3] : x.payer;
        uint256 before = _bal(x.tok, caller);
        vm.prank(caller);
        try c.withdraw(id) {
            if (caller != x.payer) nonPayerMovedFunds = true;
            uint256 got = _bal(x.tok, caller) - before;
            if (got != x.deposit - x.paid) withdrawWrong = true;
            if (x.tok == address(0)) ghostWithdrawnNative += got; else ghostWithdrawnToken += got;
            hits["withdraw"]++;
        } catch {}
    }

    function extend(uint256 seed, uint64 by) external {
        (uint256 id, bool ok) = _ch(seed);
        if (!ok) return;
        (address payer, uint64 expiry,,,,,,,) = c.channels(id);
        vm.prank(payer);
        try c.extend(id, uint64(expiry + bound(by, 1, 30 days))) {} catch {}
    }

    function warp(uint256 secs) external {
        vm.warp(block.timestamp + bound(secs, 1, 10 days));
    }

    function count() external view returns (uint256) { return ids.length; }
}

contract ZetaphyChequesInvariants is Test {
    ZetaphyCheques c;
    MockERC20 token;
    ChequesHandler h;

    function setUp() public {
        c = new ZetaphyCheques();
        token = new MockERC20("T", "T", 18);
        h = new ChequesHandler(c, token);
        targetContract(address(h));
    }

    /// Conservation: what the contract holds of each asset is exactly the sum over live channels of
    /// (deposit - paid). Nothing is created, nothing is lost, nothing is left behind.
    function invariant_conservation() public view {
        uint256 n = h.count();
        uint256 owedNative;
        uint256 owedToken;
        for (uint256 i; i < n; i++) {
            uint256 id = h.ids(i);
            ChequesHandler.Ch memory x = h.get(id);
            assertLe(x.paid, x.deposit, "paid > deposit");
            if (x.done) continue;
            if (x.tok == address(0)) owedNative += x.deposit - x.paid; else owedToken += x.deposit - x.paid;
        }
        assertEq(address(c).balance, owedNative, "native balance != sum(deposit - paid)");
        assertEq(token.balanceOf(address(c)), owedToken, "token balance != sum(deposit - paid)");
        assertEq(h.ghostDepositNative(), h.ghostCashedNative() + h.ghostWithdrawnNative() + owedNative, "native flow");
        assertEq(h.ghostDepositToken(), h.ghostCashedToken() + h.ghostWithdrawnToken() + owedToken, "token flow");
    }

    /// A cheque never pays more than the deposit not yet paid, and the payee receives exactly what cash() reports.
    function invariant_noOverpay() public view { assertFalse(h.overpaid()); }

    /// No cashing once the challenge period ended or the payer withdrew.
    function invariant_noCashAfterClose() public view { assertFalse(h.cashAfterCloseSucceeded()); }

    /// The payer's withdraw pays exactly deposit - paid; only the payer can top up / close / withdraw.
    function invariant_payerOnly() public view {
        assertFalse(h.withdrawWrong());
        assertFalse(h.nonPayerMovedFunds());
    }
}

/// The handler reaches the money-moving paths (so the invariants above are not vacuous).
contract ChequesHandlerSmoke is Test {
    function test_handlerReachesCashAndWithdraw() public {
        ZetaphyCheques c = new ZetaphyCheques();
        MockERC20 t = new MockERC20("T", "T", 18);
        ChequesHandler h = new ChequesHandler(c, t);
        h.open(0, 0, true, 100, 100, 0);
        h.open(1, 1, false, 100, 100, 1);
        h.cash(0, 50);
        h.cash(1, 70);
        h.warp(200);
        h.startClose(0, 1);
        h.warp(2 days);
        h.withdraw(0, 1);
        assertEq(h.hits("cash"), 2);
        assertEq(h.hits("withdraw"), 1);
    }
}
