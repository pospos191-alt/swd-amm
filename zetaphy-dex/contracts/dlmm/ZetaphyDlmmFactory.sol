// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// ============================================================================
// UNAUDITED. ZETAPHY DLMM factory, testnet only.
// ============================================================================

import {ZetaphyDlmmPair, ZetaphyDlmmPairDeployer, DlmmPairParameters} from "./ZetaphyDlmmPair.sol";
import {DlmmMath} from "./DlmmMath.sol";

/// Same view of Neuro's ThreatRegistry as ZetaphyFactory uses.
interface IThreatRegistryViewDlmm {
    function isContractEnforced(address who) external view returns (bool enforced, uint8 reason);
}

/// @title ZetaphyDlmmFactory: one ZetaphyDlmmPair per (token pair, bin step), CREATE2.
/// @notice UNAUDITED. Anyone may create a pair for a bin step governance has
///         enabled (a "preset": the bin step's base fee and volatility-fee
///         parameters, copied into the pair at creation and fixed for its life).
///
///         All admin functions sit behind ONE role, `governance` (onlyGov), so
///         the whole role can be handed to a TimelockController (or a multisig)
///         in two steps: setGovernance(timelock), then the timelock executes
///         acceptGovernance(). Governance may:
///           - setPreset / removePreset: the bin steps and fees of FUTURE pairs;
///           - setFeeTo: where protocol fees go (collectProtocolFees on a pair);
///           - setDefaultProtocolShare / setPairProtocolShare: the protocol's
///             part of the swap fee (0 by default, at most 50% of the fee);
///           - setThreatRegistry: Neuro's ThreatRegistry for the DLMM router
///             (zero = off; the router fails closed while it is set, exactly
///             like ZetaphyFactory / ZetaphyRouter);
///           - sweep the DLMM router's stray native coins.
///         Governance cannot move anyone's funds, pause a pair, change an
///         existing pair's fees or bin step, or upgrade anything (no proxies).
contract ZetaphyDlmmFactory {
    struct Preset {
        uint16 baseFeeBps;
        uint16 maxDynamicFeeBps;
        uint32 variableFeeControl; // 0 = no volatility fee
        uint32 filterPeriod;
        uint32 decayPeriod;
        uint16 reductionFactor;
        uint32 maxVolatilityAccumulator;
        bool enabled;
    }

    /// Bounds on presets (swdmm_math.rs: MAX_DYNAMIC_FEE_BPS = 1_000; validate_dynamic_fee).
    uint256 public constant MAX_BASE_FEE_BPS = 1_000;
    uint256 public constant MAX_DYNAMIC_FEE_BPS = 1_000;
    uint256 public constant MAX_PROTOCOL_SHARE_BPS = 5_000;
    /// Gas for the registry check in setThreatRegistry (same as ZetaphyFactory).
    uint256 public constant REGISTRY_GAS = 100_000;

    address public governance;
    address public pendingGovernance;
    address public feeTo;
    address public threatRegistry;
    uint16 public defaultProtocolShareBps;

    mapping(uint16 => Preset) public presets;
    uint16[] private _presetSteps;
    /// getPair[token0][token1][binStep] (both orders filled).
    mapping(address => mapping(address => mapping(uint16 => address))) public getPair;
    address[] public allPairs;

    /// Deploys the pairs (it holds their init code). pair =
    /// CREATE2(pairDeployer, keccak256(tokenX, tokenY, binStep), PAIR_CODE_HASH).
    address public immutable pairDeployer;
    /// keccak256 of ZetaphyDlmmPair's creation code.
    bytes32 public immutable PAIR_CODE_HASH;

    event PairCreated(address indexed tokenX, address indexed tokenY, uint16 indexed binStep, address pair, int24 activeId, uint256 allPairsLength);
    event PresetSet(uint16 indexed binStep, Preset preset);
    event PresetRemoved(uint16 indexed binStep);
    event FeeToSet(address feeTo);
    event ThreatRegistrySet(address registry);
    event DefaultProtocolShareSet(uint16 shareBps);
    event PairProtocolShareSet(address indexed pair, uint16 shareBps);
    event GovernanceProposed(address governance);
    event GovernanceSet(address governance);

    error IdenticalAddresses();
    error ZeroAddress();
    error PairExists();
    error PresetNotEnabled();
    error InvalidPreset();
    error NotGovernance();
    error NotPendingGovernance();
    error NotARegistry();
    error ShareTooHigh();
    error UnknownPair();

    modifier onlyGov() {
        if (msg.sender != governance) revert NotGovernance();
        _;
    }

    constructor(address governance_) {
        if (governance_ == address(0)) revert ZeroAddress();
        governance = governance_;
        ZetaphyDlmmPairDeployer d = new ZetaphyDlmmPairDeployer();
        pairDeployer = address(d);
        PAIR_CODE_HASH = d.PAIR_CODE_HASH();
        emit GovernanceSet(governance_);
    }

    // ---- views ----

    function allPairsLength() external view returns (uint256) {
        return allPairs.length;
    }

    function presetSteps() external view returns (uint16[] memory) {
        return _presetSteps;
    }

    // ---- pairs ----

    /// Creates the pair of tokenA and tokenB for an enabled bin step, with its
    /// active bin (starting price) at `activeId`. tokenX is the lower address.
    function createPair(address tokenA, address tokenB, uint16 binStep, int24 activeId) external returns (address pair) {
        if (tokenA == tokenB) revert IdenticalAddresses();
        (address tokenX, address tokenY) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
        if (tokenX == address(0)) revert ZeroAddress();
        if (getPair[tokenX][tokenY][binStep] != address(0)) revert PairExists();
        Preset memory p = presets[binStep];
        if (!p.enabled) revert PresetNotEnabled();
        DlmmMath.getPriceX128(activeId, binStep); // a starting bin without a valid price is refused
        DlmmPairParameters memory params = DlmmPairParameters({
            factory: address(this), tokenX: tokenX, tokenY: tokenY, binStep: binStep, activeId: activeId,
            baseFeeBps: p.baseFeeBps, maxDynamicFeeBps: p.maxDynamicFeeBps, variableFeeControl: p.variableFeeControl,
            filterPeriod: p.filterPeriod, decayPeriod: p.decayPeriod, reductionFactor: p.reductionFactor,
            maxVolatilityAccumulator: p.maxVolatilityAccumulator, protocolShareBps: defaultProtocolShareBps
        });
        pair = ZetaphyDlmmPairDeployer(pairDeployer).deploy(keccak256(abi.encodePacked(tokenX, tokenY, binStep)), params);
        getPair[tokenX][tokenY][binStep] = pair;
        getPair[tokenY][tokenX][binStep] = pair;
        allPairs.push(pair);
        emit PairCreated(tokenX, tokenY, binStep, pair, activeId, allPairs.length);
    }

    // ---- governance ----

    /// Enables (or changes) a bin step for NEW pairs; existing pairs keep theirs.
    function setPreset(uint16 binStep, Preset calldata p) external onlyGov {
        if (binStep == 0 || binStep > DlmmMath.MAX_BIN_STEP) revert InvalidPreset();
        if (p.baseFeeBps > MAX_BASE_FEE_BPS) revert InvalidPreset();
        if (p.variableFeeControl != 0) {
            // swdmm_math.rs validate_dynamic_fee
            if (p.maxDynamicFeeBps == 0 || p.maxDynamicFeeBps > MAX_DYNAMIC_FEE_BPS) revert InvalidPreset();
            if (p.filterPeriod >= p.decayPeriod) revert InvalidPreset();
            if (p.reductionFactor > 10_000) revert InvalidPreset();
            if (p.maxVolatilityAccumulator == 0) revert InvalidPreset();
        }
        if (!presets[binStep].enabled) _presetSteps.push(binStep);
        Preset memory q = p;
        q.enabled = true;
        presets[binStep] = q;
        emit PresetSet(binStep, q);
    }

    /// Stops new pairs with this bin step; existing pairs are not affected.
    function removePreset(uint16 binStep) external onlyGov {
        if (!presets[binStep].enabled) revert PresetNotEnabled();
        delete presets[binStep];
        uint256 n = _presetSteps.length;
        for (uint256 i; i < n; i++) {
            if (_presetSteps[i] == binStep) {
                _presetSteps[i] = _presetSteps[n - 1];
                _presetSteps.pop();
                break;
            }
        }
        emit PresetRemoved(binStep);
    }

    function setFeeTo(address feeTo_) external onlyGov {
        feeTo = feeTo_;
        emit FeeToSet(feeTo_);
    }

    /// The protocol share new pairs start with.
    function setDefaultProtocolShare(uint16 shareBps) external onlyGov {
        if (shareBps > MAX_PROTOCOL_SHARE_BPS) revert ShareTooHigh();
        defaultProtocolShareBps = shareBps;
        emit DefaultProtocolShareSet(shareBps);
    }

    /// The protocol share of an existing pair (made by this factory).
    function setPairProtocolShare(address pair, uint16 shareBps) external onlyGov {
        ZetaphyDlmmPair p = ZetaphyDlmmPair(pair);
        if (getPair[p.tokenX()][p.tokenY()][p.binStep()] != pair) revert UnknownPair();
        p.setProtocolShare(shareBps);
        emit PairProtocolShareSet(pair, shareBps);
    }

    /// Zero switches the router's Neuro check off. A nonzero address must
    /// answer isContractEnforced within REGISTRY_GAS (checked here).
    function setThreatRegistry(address registry) external onlyGov {
        if (registry != address(0)) {
            (bool ok, bytes memory r) = registry.staticcall{gas: REGISTRY_GAS}(abi.encodeCall(IThreatRegistryViewDlmm.isContractEnforced, (address(this))));
            if (!ok || r.length < 64) revert NotARegistry();
        }
        threatRegistry = registry;
        emit ThreatRegistrySet(registry);
    }

    /// Step 1 of handing governance over (e.g. to a TimelockController).
    function setGovernance(address next) external onlyGov {
        pendingGovernance = next;
        emit GovernanceProposed(next);
    }

    /// Step 2: the new governance accepts (a timelock executes this call).
    function acceptGovernance() external {
        if (msg.sender != pendingGovernance) revert NotPendingGovernance();
        governance = msg.sender;
        pendingGovernance = address(0);
        emit GovernanceSet(msg.sender);
    }
}
