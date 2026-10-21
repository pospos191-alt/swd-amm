// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// ============================================================================
// UNAUDITED. ZETAPHY DLMM pair (discrete liquidity bins), testnet only.
// Not reviewed by any third party. Do not put value you cannot lose in it.
// ============================================================================
//
// A port of our own Solana DLMM (programs/swd_amm/src/dlmm.rs, with the
// volatility fee of swdmm_math.rs) to the EVM, written from scratch (MIT):
//
//   - Liquidity sits in BINS. Bin `id` trades at the fixed price
//     (1 + binStep/10_000)^id tokenY per tokenX (DlmmMath.getPriceX128,
//     128.128 fixed point). Inside a bin the price does not move.
//   - The ACTIVE bin is the current price. Bins above it hold only tokenX
//     (sold as the price rises), bins below it only tokenY; the active bin
//     may hold both. Deposits must respect this (SingleSidedViolation).
//   - A swap starts at the active bin and crosses bins in its direction
//     (X in: down, Y in: up), jumping over empty bins with a bitmap
//     (DlmmBinTree). At most MAX_BINS_CROSSED bins per swap (gas bound).
//     A swap that cannot be filled reverts (OutOfLiquidity); nothing is
//     ever partly filled.
//   - Shares are per bin (an internal ERC-1155-like ledger, see below).
//     The first deposit into an empty bin mints its value in tokenY scaled
//     by 2^128: x * price + y * 2^128 (exact, no rounding). Later deposits
//     mint in proportion to the bin's current reserves and only take the
//     amounts in the bin's own X:Y ratio (the rest is refunded): a deposit
//     can never swap at the bin price for free.
//   - Fee = base fee + volatility fee (as in swdmm_math.rs): the volatility
//     accumulator grows with the number of bins the price moved from a
//     reference bin, decays with time, and is capped. The fee of each bin is
//     taken from the input used in that bin and stays in that bin (its LPs),
//     except the protocol share, which governance sets (0 by default) and
//     which is paid to the factory's feeTo.
//   - Internal accounting: reserves are tracked in storage; the token
//     balances are only read to see what came in. Tokens sent to the pair
//     outside a call (donations) never change a bin or the price; the next
//     caller's input includes them, or skim() takes them.
//   - Rounding is always in the pool's favour: inputs and fees round up,
//     outputs and minted shares round down.
//   - No flash swaps and no callbacks into user code. Every state-changing
//     function takes one reentrancy lock; state is written before tokens
//     are sent out (checks-effects-interactions).
//   - Fee-on-transfer and rebasing tokens are not supported: the router
//     refuses inputs that arrive short, and after a swap the pair checks
//     that it still holds what it accounts for (BalanceBelowReserves).
//   - No admin can move funds, pause the pair or change its fees. The
//     factory (governance) can only set the protocol share (capped).

import {DlmmMath, DlmmBinTree} from "./DlmmMath.sol";

/// Parameters a new pair reads from its deployer in its constructor.
struct DlmmPairParameters {
    address factory;
    address tokenX;
    address tokenY;
    uint16 binStep;
    int24 activeId;
    uint16 baseFeeBps;
    uint16 maxDynamicFeeBps;
    uint32 variableFeeControl;
    uint32 filterPeriod;
    uint32 decayPeriod;
    uint16 reductionFactor;
    uint32 maxVolatilityAccumulator;
    uint16 protocolShareBps;
}

interface IDlmmFactoryForPair {
    function feeTo() external view returns (address);
}

interface IDlmmPairDeployer {
    function pairParameters() external view returns (DlmmPairParameters memory);
}

interface IERC20DlmmPair {
    function balanceOf(address) external view returns (uint256);
}

contract ZetaphyDlmmPair {
    using DlmmBinTree for DlmmBinTree.Tree;

    // ---- limits ----
    /// Most bins one swap may cross (counting only bins with liquidity, plus
    /// the active bin). dlmm.rs used 30 on Solana; the EVM's gas allows more.
    uint256 public constant MAX_BINS_CROSSED = 100;
    /// Most bins one mint / burn / transfer may touch.
    uint256 public constant MAX_BINS_PER_CALL = 100;
    /// Ceilings on the fee (base + volatility) and on the protocol's part of it.
    uint256 public constant MAX_TOTAL_FEE_BPS = 1_000;
    uint256 public constant MAX_PROTOCOL_SHARE_BPS = 5_000;
    uint256 private constant BPS = 10_000;
    uint256 private constant ID_OFFSET = 1 << 23;

    // ---- immutable configuration ----
    address public immutable factory;
    address public immutable tokenX;
    address public immutable tokenY;
    uint16 public immutable binStep;
    uint16 public immutable baseFeeBps;
    uint16 public immutable maxDynamicFeeBps;
    uint32 public immutable variableFeeControl;
    uint32 public immutable filterPeriod;
    uint32 public immutable decayPeriod;
    uint16 public immutable reductionFactor;
    uint32 public immutable maxVolatilityAccumulator;

    // ---- state ----
    struct State {
        int24 activeId;
        int24 idReference;
        uint32 volatilityAccumulator;
        uint32 volatilityReference;
        uint40 lastUpdate;
        uint16 protocolShareBps;
    }

    struct Bin {
        uint128 x;
        uint128 y;
    }

    State private _state;
    /// Sums of every bin's reserves (what LPs own).
    uint128 public reserveX;
    uint128 public reserveY;
    /// Protocol fees waiting for collectProtocolFees().
    uint128 public protocolFeesX;
    uint128 public protocolFeesY;
    uint256 private _unlocked = 1;

    mapping(int24 => Bin) private _bins;
    mapping(int24 => uint256) public totalSupply;
    mapping(address => mapping(int24 => uint256)) private _balances;
    mapping(address => mapping(address => bool)) public isApprovedForAll;
    DlmmBinTree.Tree private _tree;

    // ---- events ----
    event Swap(address indexed sender, address indexed to, bool swapForY, uint256 amountIn, uint256 amountOut,
        int24 activeId, uint256 fees, uint256 protocolFees, uint256 volatilityAccumulator);
    event DepositedToBins(address indexed sender, address indexed to, int24[] ids, uint256[] amountsX, uint256[] amountsY, uint256[] shares);
    event WithdrawnFromBins(address indexed sender, address indexed from, address indexed to, int24[] ids, uint256[] shares, uint256 amountX, uint256 amountY);
    event TransferBatch(address indexed operator, address indexed from, address indexed to, int24[] ids, uint256[] amounts);
    event ApprovalForAll(address indexed account, address indexed operator, bool approved);
    event ActiveIdSet(int24 activeId);
    event ProtocolShareSet(uint16 protocolShareBps);
    event ProtocolFeesCollected(address indexed to, uint256 amountX, uint256 amountY);
    event Skimmed(address indexed to, uint256 amountX, uint256 amountY);

    // ---- errors ----
    error Locked();
    error NotFactory();
    error NotApproved();
    error InvalidLength();
    error IdsNotSorted();
    error SingleSidedViolation(int24 id);
    error ZeroShares(int24 id);
    error InsufficientShares(int24 id);
    error InsufficientAmountIn();
    error InsufficientAmountOut();
    error ZeroAmount();
    error OutOfLiquidity();
    error TooManyBinsCrossed();
    error NotEmpty();
    error Overflow();
    error FeeToNotSet();
    error ShareTooHigh();
    error TransferFailed();
    error BalanceBelowReserves();
    error InvalidRecipient();

    modifier lock() {
        if (_unlocked != 1) revert Locked();
        _unlocked = 2;
        _;
        _unlocked = 1;
    }

    /// Created by the factory's ZetaphyDlmmPairDeployer with CREATE2; every
    /// parameter comes from the deployer, so the init code (and the pair's
    /// address) does not depend on them.
    constructor() {
        DlmmPairParameters memory p = IDlmmPairDeployer(msg.sender).pairParameters();
        factory = p.factory;
        tokenX = p.tokenX;
        tokenY = p.tokenY;
        binStep = p.binStep;
        baseFeeBps = p.baseFeeBps;
        maxDynamicFeeBps = p.maxDynamicFeeBps;
        variableFeeControl = p.variableFeeControl;
        filterPeriod = p.filterPeriod;
        decayPeriod = p.decayPeriod;
        reductionFactor = p.reductionFactor;
        maxVolatilityAccumulator = p.maxVolatilityAccumulator;
        DlmmMath.getPriceX128(p.activeId, p.binStep); // the starting bin must have a price
        _state = State({activeId: p.activeId, idReference: p.activeId, volatilityAccumulator: 0, volatilityReference: 0,
            lastUpdate: uint40(block.timestamp), protocolShareBps: p.protocolShareBps});
    }

    // =====================================================================
    // Views
    // =====================================================================

    function getActiveId() external view returns (int24) {
        return _state.activeId;
    }

    function getBin(int24 id) external view returns (uint128 x, uint128 y) {
        Bin memory b = _bins[id];
        return (b.x, b.y);
    }

    function getPriceFromId(int24 id) external view returns (uint256 priceX128) {
        return DlmmMath.getPriceX128(id, binStep);
    }

    function protocolShareBps() external view returns (uint16) {
        return _state.protocolShareBps;
    }

    function getVolatility() external view returns (uint32 volatilityAccumulator, uint32 volatilityReference, int24 idReference, uint40 lastUpdate) {
        State memory s = _state;
        return (s.volatilityAccumulator, s.volatilityReference, s.idReference, s.lastUpdate);
    }

    function balanceOf(address account, int24 id) external view returns (uint256) {
        return _balances[account][id];
    }

    /// The nearest bin with liquidity strictly below (or above) `id`; found = false if none.
    function getNextNonEmptyBin(bool below, int24 id) external view returns (int24 next, bool found) {
        uint256 i = below ? _tree.below(_index(id)) : _tree.above(_index(id));
        if (i == DlmmBinTree.NONE) return (id, false);
        return (_id(i), true);
    }

    /// What swap() would do now with `amountIn`: the output, the input it
    /// could not place (0 unless liquidity runs out), and the total fee.
    function getSwapOut(uint256 amountIn, bool swapForY) external view returns (uint256 amountInLeft, uint256 amountOut, uint256 fees) {
        SwapResult memory r = _runSwap(swapForY, amountIn, false);
        return (r.amountInLeft, r.amountOut, r.fees);
    }

    /// The smallest input for which swap() pays at least `amountOut` now
    /// (amountOutLeft > 0: the pair cannot pay that much). Same bins, prices
    /// and fees as swap(), rounded the same way.
    function getSwapIn(uint256 amountOut, bool swapForY) external view returns (uint256 amountIn, uint256 amountOutLeft, uint256 fees) {
        State memory s = _state;
        _updateReferences(s);
        int24 id = s.activeId;
        amountOutLeft = amountOut;
        uint256 crossed;
        while (amountOutLeft != 0) {
            Bin memory b = _bins[id];
            uint256 binOut = swapForY ? b.y : b.x;
            if (binOut != 0) {
                uint256 feeBps = _feeBps(s, id);
                uint256 price = DlmmMath.getPriceX128(id, binStep);
                uint256 out = amountOutLeft < binOut ? amountOutLeft : binOut;
                uint256 net = swapForY ? DlmmMath.divPriceUp(out, price) : DlmmMath.mulPriceUp(out, price);
                uint256 gross = DlmmMath.ceilDiv(net * BPS, BPS - feeBps);
                amountIn += gross;
                fees += gross - net;
                amountOutLeft -= out;
                if (amountOutLeft == 0) break;
            }
            uint256 i = swapForY ? _tree.below(_index(id)) : _tree.above(_index(id));
            if (i == DlmmBinTree.NONE) break;
            id = _id(i);
            if (++crossed > MAX_BINS_CROSSED) revert TooManyBinsCrossed();
        }
    }

    // =====================================================================
    // Swap
    // =====================================================================

    /// Swaps what was sent to the pair since the last update (tokenX if
    /// swapForY, else tokenY) and sends the output to `to`. Call it in the
    /// same transaction as the transfer in (the router does), with your own
    /// minimum-output check: the pair has none.
    function swap(bool swapForY, address to) external lock returns (uint256 amountOut) {
        if (to == address(0) || to == address(this)) revert InvalidRecipient();
        (address tokenIn, address tokenOut) = swapForY ? (tokenX, tokenY) : (tokenY, tokenX);
        uint256 amountIn = _received(tokenIn, swapForY);
        if (amountIn == 0) revert InsufficientAmountIn();

        SwapResult memory r = _runSwap(swapForY, amountIn, true);
        if (r.amountInLeft != 0) revert OutOfLiquidity();
        amountOut = r.amountOut;
        if (amountOut == 0) revert InsufficientAmountOut();
        for (uint256 k; k < r.touched; k++) {
            uint256 v = r.packed[k];
            _bins[r.ids[k]] = Bin(uint128(v >> 128), uint128(v));
        }
        {
            State memory s = _state;
            s.activeId = r.activeId;
            s.volatilityAccumulator = r.volatilityAccumulator;
            s.lastUpdate = uint40(block.timestamp);
            (s.idReference, s.volatilityReference) = (r.idReference, r.volatilityReference);
            _state = s;
        }

        uint256 toBins = amountIn - r.protocolFees;
        if (swapForY) {
            reserveX = _u128(reserveX + toBins);
            reserveY -= uint128(amountOut);
            protocolFeesX = _u128(protocolFeesX + r.protocolFees);
        } else {
            reserveY = _u128(reserveY + toBins);
            reserveX -= uint128(amountOut);
            protocolFeesY = _u128(protocolFeesY + r.protocolFees);
        }
        _safeTransfer(tokenOut, to, amountOut);
        // A token whose balance can shrink on its own (rebasing) or that took
        // more than it said: refuse to pay out what the pair does not hold.
        _checkSolvent(tokenOut, !swapForY);
        emit Swap(msg.sender, to, swapForY, amountIn, amountOut, r.activeId, r.fees, r.protocolFees, r.volatilityAccumulator);
    }

    struct SwapResult {
        uint256 amountInLeft;
        uint256 amountOut;
        uint256 fees;
        uint256 protocolFees;
        int24 activeId;
        uint32 volatilityAccumulator;
        int24 idReference;
        uint32 volatilityReference;
        // swap() only: the bins the swap changed and their new reserves (x << 128 | y)
        uint256 touched;
        int24[] ids;
        uint256[] packed;
    }

    /// The bin-crossing loop shared by swap() (record = true: also returns
    /// the new reserves of every bin it changed, which swap() then writes)
    /// and getSwapOut() (record = false). A view: one code path for both.
    function _runSwap(bool swapForY, uint256 amountIn, bool record) private view returns (SwapResult memory r) {
        State memory s = _state;
        _updateReferences(s);
        int24 id = s.activeId;
        r.amountInLeft = amountIn;
        if (record) {
            r.ids = new int24[](MAX_BINS_CROSSED + 1);
            r.packed = new uint256[](MAX_BINS_CROSSED + 1);
        }
        uint256 crossed;
        while (true) {
            if (_stepBin(r, s, id, swapForY, record)) break;
            uint256 i = swapForY ? _tree.below(_index(id)) : _tree.above(_index(id));
            if (i == DlmmBinTree.NONE) break; // out of liquidity: the caller decides
            id = _id(i);
            if (++crossed > MAX_BINS_CROSSED) revert TooManyBinsCrossed();
        }
        r.activeId = id;
        r.volatilityAccumulator = s.volatilityAccumulator;
        r.idReference = s.idReference;
        r.volatilityReference = s.volatilityReference;
    }

    /// Trades in bin `id` (if it has output-side liquidity); true when the input is used up.
    function _stepBin(SwapResult memory r, State memory s, int24 id, bool swapForY, bool record) private view returns (bool done) {
        Bin memory b = _bins[id];
        uint256 binOut = swapForY ? b.y : b.x;
        if (binOut == 0) return false;
        uint256 feeBps = _feeBps(s, id);
        (uint256 inUsed, uint256 out, uint256 fee) = _binSwap(binOut, DlmmMath.getPriceX128(id, binStep), feeBps, r.amountInLeft, swapForY);
        uint256 pFee = (fee * s.protocolShareBps) / BPS;
        if (record) {
            if (swapForY) {
                b.x = _u128(b.x + inUsed - pFee);
                b.y -= uint128(out);
            } else {
                b.y = _u128(b.y + inUsed - pFee);
                b.x -= uint128(out);
            }
            r.ids[r.touched] = id;
            r.packed[r.touched] = (uint256(b.x) << 128) | b.y;
            r.touched++;
        }
        r.amountInLeft -= inUsed;
        r.amountOut += out;
        r.fees += fee;
        r.protocolFees += pFee;
        return r.amountInLeft == 0;
    }

    /// One bin: (input used, output, fee). Drains the bin if the input is
    /// enough, else converts all of it. Input and fee round up, output down.
    function _binSwap(uint256 binOut, uint256 price, uint256 feeBps, uint256 amountIn, bool swapForY)
        private pure returns (uint256 inUsed, uint256 out, uint256 fee)
    {
        uint256 netNeeded = swapForY ? DlmmMath.divPriceUp(binOut, price) : DlmmMath.mulPriceUp(binOut, price);
        uint256 grossNeeded = DlmmMath.ceilDiv(netNeeded * BPS, BPS - feeBps);
        if (amountIn >= grossNeeded) return (grossNeeded, binOut, grossNeeded - netNeeded);
        fee = DlmmMath.ceilDiv(amountIn * feeBps, BPS);
        uint256 net = amountIn - fee;
        out = swapForY ? DlmmMath.mulPriceDown(net, price) : DlmmMath.divPriceDown(net, price);
        // net < netNeeded, so out < binOut; kept as a hard stop.
        if (out >= binOut) revert Overflow();
        return (amountIn, out, fee);
    }

    // ---- volatility fee (swdmm_math.rs: update_references / accumulate / variable_fee_bps) ----

    /// At the start of a swap: after filterPeriod without a swap the
    /// reference bin moves to the current one; the volatility carried over
    /// decays by reductionFactor, and to zero after decayPeriod.
    function _updateReferences(State memory s) private view {
        uint256 elapsed = block.timestamp - s.lastUpdate;
        if (elapsed >= filterPeriod) {
            s.idReference = s.activeId;
            s.volatilityReference = elapsed < decayPeriod ? uint32((uint256(s.volatilityAccumulator) * reductionFactor) / BPS) : 0;
        }
    }

    /// Fee (bps) for trading in bin `id`; updates the accumulator: reference
    /// + |id - idReference| * binStep (the price move in bps), capped.
    function _feeBps(State memory s, int24 id) private view returns (uint256 fee) {
        fee = baseFeeBps;
        if (variableFeeControl == 0) return fee;
        int256 d = int256(id) - int256(s.idReference);
        uint256 acc = uint256(s.volatilityReference) + (d < 0 ? uint256(-d) : uint256(d)) * binStep;
        if (acc > maxVolatilityAccumulator) acc = maxVolatilityAccumulator;
        s.volatilityAccumulator = uint32(acc);
        uint256 v = (acc * variableFeeControl) / BPS;
        if (v > maxDynamicFeeBps) v = maxDynamicFeeBps;
        fee += v;
        if (fee > MAX_TOTAL_FEE_BPS) fee = MAX_TOTAL_FEE_BPS;
    }

    // =====================================================================
    // Liquidity
    // =====================================================================

    struct MintCtx {
        int24 active;
        uint256 receivedX;
        uint256 receivedY;
        uint256 usedX;
        uint256 usedY;
    }

    /// Deposits into bins `ids` (strictly increasing) the amounts sent to the
    /// pair since the last update. Bins above the active bin take only X,
    /// bins below only Y. Shares go to `to`; whatever a bin did not take
    /// (and any surplus sent) goes back to `refundTo`.
    function mint(address to, int24[] calldata ids, uint256[] calldata amountsX, uint256[] calldata amountsY, address refundTo)
        external lock returns (uint256 usedX, uint256 usedY, uint256[] memory shares)
    {
        uint256 n = ids.length;
        if (n == 0 || n > MAX_BINS_PER_CALL || amountsX.length != n || amountsY.length != n) revert InvalidLength();
        if (to == address(0)) revert InvalidRecipient();
        MintCtx memory c;
        c.active = _state.activeId;
        c.receivedX = _received(tokenX, true);
        c.receivedY = _received(tokenY, false);
        shares = new uint256[](n);
        for (uint256 i; i < n; i++) {
            if (i > 0 && ids[i] <= ids[i - 1]) revert IdsNotSorted();
            shares[i] = _mintBin(c, to, ids[i], amountsX[i], amountsY[i]);
        }
        (usedX, usedY) = (c.usedX, c.usedY);
        if (usedX == 0 && usedY == 0) revert ZeroAmount();
        if (usedX > c.receivedX || usedY > c.receivedY) revert InsufficientAmountIn();
        reserveX = _u128(reserveX + usedX);
        reserveY = _u128(reserveY + usedY);
        emit TransferBatch(msg.sender, address(0), to, ids, shares);
        emit DepositedToBins(msg.sender, to, ids, amountsX, amountsY, shares);
        if (c.receivedX > usedX) _safeTransfer(tokenX, refundTo, c.receivedX - usedX);
        if (c.receivedY > usedY) _safeTransfer(tokenY, refundTo, c.receivedY - usedY);
    }

    function _mintBin(MintCtx memory c, address to, int24 id, uint256 x, uint256 y) private returns (uint256 minted) {
        if ((id > c.active && y != 0) || (id < c.active && x != 0)) revert SingleSidedViolation(id);
        if (x == 0 && y == 0) return 0;
        uint256 price = DlmmMath.getPriceX128(id, binStep); // refuses bins without a valid price
        Bin memory b = _bins[id];
        uint256 supply = totalSupply[id];
        uint256 takeX;
        uint256 takeY;
        if (supply == 0) {
            // Empty bin: shares = its value in Y, scaled by 2^128 (exact).
            minted = x * price + (y << 128); // reverts on overflow: the bin would be worth > ~2^128 Y
            if (y >= 1 << 128) revert Overflow();
            (takeX, takeY) = (x, y);
            _tree.add(_index(id));
        } else {
            // Non-empty bin: the share of the bin the smaller side buys,
            // rounded down; the amounts it costs, rounded up.
            minted = type(uint256).max;
            if (b.x != 0) minted = DlmmMath.mulDiv(x, supply, b.x);
            if (b.y != 0) {
                uint256 sy = DlmmMath.mulDiv(y, supply, b.y);
                if (sy < minted) minted = sy;
            }
            if (b.x != 0) takeX = DlmmMath.mulDivUp(minted, b.x, supply);
            if (b.y != 0) takeY = DlmmMath.mulDivUp(minted, b.y, supply);
        }
        if (minted == 0) revert ZeroShares(id);
        _bins[id] = Bin(_u128(b.x + takeX), _u128(b.y + takeY));
        totalSupply[id] = supply + minted;
        _balances[to][id] += minted;
        c.usedX += takeX;
        c.usedY += takeY;
    }

    /// Burns `from`'s shares in bins `ids` and sends their part of each bin
    /// (rounded down) to `to`. msg.sender must be `from` or approved by it.
    function burn(address from, address to, int24[] calldata ids, uint256[] calldata shares)
        external lock returns (uint256 amountX, uint256 amountY)
    {
        if (msg.sender != from && !isApprovedForAll[from][msg.sender]) revert NotApproved();
        uint256 n = ids.length;
        if (n == 0 || n > MAX_BINS_PER_CALL || shares.length != n) revert InvalidLength();
        if (to == address(0) || to == address(this)) revert InvalidRecipient();
        for (uint256 i; i < n; i++) {
            (uint256 ox, uint256 oy) = _burnBin(from, ids[i], shares[i]);
            amountX += ox;
            amountY += oy;
        }
        if (amountX == 0 && amountY == 0) revert ZeroAmount();
        reserveX -= uint128(amountX);
        reserveY -= uint128(amountY);
        emit TransferBatch(msg.sender, from, address(0), ids, shares);
        emit WithdrawnFromBins(msg.sender, from, to, ids, shares, amountX, amountY);
        if (amountX != 0) _safeTransfer(tokenX, to, amountX);
        if (amountY != 0) _safeTransfer(tokenY, to, amountY);
    }

    function _burnBin(address from, int24 id, uint256 amount) private returns (uint256 ox, uint256 oy) {
        if (amount == 0) return (0, 0);
        uint256 bal = _balances[from][id];
        if (amount > bal) revert InsufficientShares(id);
        uint256 supply = totalSupply[id];
        Bin memory b = _bins[id];
        ox = DlmmMath.mulDiv(b.x, amount, supply);
        oy = DlmmMath.mulDiv(b.y, amount, supply);
        unchecked {
            _balances[from][id] = bal - amount;
        }
        totalSupply[id] = supply - amount;
        if (supply == amount) {
            // Last shares: the whole bin (ox == b.x, oy == b.y).
            delete _bins[id];
            _tree.remove(_index(id));
        } else {
            _bins[id] = Bin(b.x - uint128(ox), b.y - uint128(oy));
        }
    }

    /// While the pair holds no liquidity at all, anyone may move its active
    /// bin (the first LP sets the price; the router does this together with
    /// the first deposit and checks the active bin against the caller's).
    function setActiveIdWhileEmpty(int24 id) external lock {
        if (reserveX != 0 || reserveY != 0) revert NotEmpty();
        DlmmMath.getPriceX128(id, binStep);
        State memory s = _state;
        s.activeId = id;
        s.idReference = id;
        s.volatilityAccumulator = 0;
        s.volatilityReference = 0;
        _state = s;
        emit ActiveIdSet(id);
    }

    // =====================================================================
    // Shares (internal ERC-1155-like ledger; no receiver callbacks, by design)
    // =====================================================================

    function setApprovalForAll(address operator, bool approved) external {
        isApprovedForAll[msg.sender][operator] = approved;
        emit ApprovalForAll(msg.sender, operator, approved);
    }

    function batchTransferFrom(address from, address to, int24[] calldata ids, uint256[] calldata amounts) external {
        if (msg.sender != from && !isApprovedForAll[from][msg.sender]) revert NotApproved();
        if (to == address(0) || to == address(this)) revert InvalidRecipient();
        uint256 n = ids.length;
        if (n > MAX_BINS_PER_CALL || amounts.length != n) revert InvalidLength();
        for (uint256 i; i < n; i++) {
            uint256 bal = _balances[from][ids[i]];
            if (amounts[i] > bal) revert InsufficientShares(ids[i]);
            unchecked {
                _balances[from][ids[i]] = bal - amounts[i];
            }
            _balances[to][ids[i]] += amounts[i];
        }
        emit TransferBatch(msg.sender, from, to, ids, amounts);
    }

    // =====================================================================
    // Protocol fee, skim, factory
    // =====================================================================

    /// Sends the protocol fees to the factory's feeTo (anyone may call; the recipient is fixed).
    function collectProtocolFees() external lock returns (uint256 amountX, uint256 amountY) {
        address to = IDlmmFactoryForPair(factory).feeTo();
        if (to == address(0)) revert FeeToNotSet();
        (amountX, amountY) = (protocolFeesX, protocolFeesY);
        protocolFeesX = 0;
        protocolFeesY = 0;
        if (amountX != 0) _safeTransfer(tokenX, to, amountX);
        if (amountY != 0) _safeTransfer(tokenY, to, amountY);
        emit ProtocolFeesCollected(to, amountX, amountY);
    }

    /// Sends whatever the pair holds above its accounting (e.g. tokens sent by mistake) to `to`.
    function skim(address to) external lock {
        if (to == address(0) || to == address(this)) revert InvalidRecipient();
        uint256 ex = _received(tokenX, true);
        uint256 ey = _received(tokenY, false);
        if (ex != 0) _safeTransfer(tokenX, to, ex);
        if (ey != 0) _safeTransfer(tokenY, to, ey);
        emit Skimmed(to, ex, ey);
    }

    function setProtocolShare(uint16 shareBps) external {
        if (msg.sender != factory) revert NotFactory();
        if (shareBps > MAX_PROTOCOL_SHARE_BPS) revert ShareTooHigh();
        if (_unlocked != 1) revert Locked();
        _state.protocolShareBps = shareBps;
        emit ProtocolShareSet(shareBps);
    }

    // =====================================================================
    // Internals
    // =====================================================================

    function _index(int24 id) private pure returns (uint256) {
        return uint256(int256(id) + int256(ID_OFFSET));
    }

    function _id(uint256 index) private pure returns (int24) {
        return int24(int256(index) - int256(ID_OFFSET));
    }

    function _u128(uint256 v) private pure returns (uint128) {
        if (v > type(uint128).max) revert Overflow();
        return uint128(v);
    }

    /// Balance above what the pair accounts for (reserves + protocol fees).
    function _received(address token, bool isX) private view returns (uint256) {
        uint256 bal = IERC20DlmmPair(token).balanceOf(address(this));
        uint256 tracked = isX ? uint256(reserveX) + protocolFeesX : uint256(reserveY) + protocolFeesY;
        return bal > tracked ? bal - tracked : 0;
    }

    function _checkSolvent(address token, bool isX) private view {
        uint256 tracked = isX ? uint256(reserveX) + protocolFeesX : uint256(reserveY) + protocolFeesY;
        if (IERC20DlmmPair(token).balanceOf(address(this)) < tracked) revert BalanceBelowReserves();
    }

    /// transfer(), accepting tokens that return nothing but not ones that return false.
    function _safeTransfer(address token, address to, uint256 value) private {
        (bool ok, bytes memory data) = token.call(abi.encodeWithSelector(0xa9059cbb, to, value));
        if (!ok || (data.length != 0 && (data.length < 32 || !abi.decode(data, (bool))))) revert TransferFailed();
    }
}

/// Holds the pair's init code so the factory stays under the EIP-170 size
/// limit. Created by the factory in its constructor; only that factory may
/// deploy pairs through it. pair = CREATE2(deployer, salt, PAIR_CODE_HASH).
contract ZetaphyDlmmPairDeployer {
    address public immutable factory;
    DlmmPairParameters private _params;

    error NotFactory();

    constructor() {
        factory = msg.sender;
    }

    /// keccak256 of ZetaphyDlmmPair's init code (computed here, at run time,
    /// so the init code is stored once).
    function PAIR_CODE_HASH() external pure returns (bytes32) {
        return keccak256(type(ZetaphyDlmmPair).creationCode);
    }

    /// Read by a new pair's constructor (only set during deploy).
    function pairParameters() external view returns (DlmmPairParameters memory) {
        return _params;
    }

    function deploy(bytes32 salt, DlmmPairParameters calldata p) external returns (address pair) {
        if (msg.sender != factory) revert NotFactory();
        _params = p;
        pair = address(new ZetaphyDlmmPair{salt: salt}());
        delete _params;
    }
}
