// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ZetaphyPair} from "./ZetaphyPair.sol";

/// The part of Neuro's ThreatRegistry (zetaphy-network/contracts/ThreatRegistry.sol)
/// the DEX reads: true once a flag on the contract's address on this chain, or
/// on its exact code (extcodehash), is enforced. Reason: ThreatRegistry.Reason.
interface IThreatRegistryView {
    function isContractEnforced(address who) external view returns (bool enforced, uint8 reason);
}

/// @title ZetaphyFactory: creates one ZetaphyPair per token pair (CREATE2) and
///        holds the DEX's governance settings.
/// @notice Governance (a multisig on the testnet) may:
///           - setFeeTo(a):           the protocol fee switch. Zero (the default) = off;
///                                    otherwise 1/6 of the 0.3% LP fee goes to `a` as LP tokens;
///           - setThreatRegistry(r):  Neuro's ThreatRegistry. Zero (the default) = off;
///                                    otherwise the router refuses to swap into, or add
///                                    liquidity with, a token whose flag is ENFORCED there.
///                                    Selling a token for the native coin and removing
///                                    liquidity never ask the registry, so they always work;
///           - sweep the router's stray native coins (ZetaphyRouter.sweep; never user funds);
///           - transfer governance (two steps: setGovernance, then acceptGovernance).
///         Governance cannot move anyone's funds, change the 0.3% fee, or stop the
///         pairs themselves (they never ask the registry). It CAN stop buying through
///         the router: the router's registry check fails closed, so a registry that
///         stops answering (or that answers "enforced" for every token) makes the
///         router refuse every swap into a token and every add of liquidity until
///         governance sets the registry to zero (which lifts it at once). The check
///         here (setThreatRegistry) only proves the registry answered when it was set.
contract ZetaphyFactory {
    address public governance;
    address public pendingGovernance;
    address public feeTo;
    address public threatRegistry;

    mapping(address => mapping(address => address)) public getPair;
    address[] public allPairs;

    /// keccak256 of ZetaphyPair's creation code: pair = CREATE2(this, keccak256(token0, token1), PAIR_CODE_HASH).
    bytes32 public immutable PAIR_CODE_HASH;

    address private _p0;
    address private _p1;

    event PairCreated(address indexed token0, address indexed token1, address pair, uint256 allPairsLength);
    event FeeToSet(address feeTo);
    event ThreatRegistrySet(address registry);
    event GovernanceProposed(address governance);
    event GovernanceSet(address governance);

    error IdenticalAddresses();
    error ZeroAddress();
    error PairExists();
    error NotGovernance();
    error NotPendingGovernance();
    error NotARegistry();

    modifier onlyGov() {
        if (msg.sender != governance) revert NotGovernance();
        _;
    }

    constructor(address governance_) {
        if (governance_ == address(0)) revert ZeroAddress();
        governance = governance_;
        PAIR_CODE_HASH = keccak256(type(ZetaphyPair).creationCode);
        emit GovernanceSet(governance_);
    }

    function allPairsLength() external view returns (uint256) {
        return allPairs.length;
    }

    /// Read by a new pair's constructor (only set during createPair).
    function pairParameters() external view returns (address token0, address token1) {
        return (_p0, _p1);
    }

    function createPair(address tokenA, address tokenB) external returns (address pair) {
        if (tokenA == tokenB) revert IdenticalAddresses();
        (address token0, address token1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
        if (token0 == address(0)) revert ZeroAddress();
        if (getPair[token0][token1] != address(0)) revert PairExists();
        _p0 = token0;
        _p1 = token1;
        pair = address(new ZetaphyPair{salt: keccak256(abi.encodePacked(token0, token1))}());
        delete _p0;
        delete _p1;
        getPair[token0][token1] = pair;
        getPair[token1][token0] = pair;
        allPairs.push(pair);
        emit PairCreated(token0, token1, pair, allPairs.length);
    }

    function setFeeTo(address feeTo_) external onlyGov {
        feeTo = feeTo_;
        emit FeeToSet(feeTo_);
    }

    /// Gas for the query below; the same cap as ZetaphyRouter.REGISTRY_GAS.
    uint256 public constant REGISTRY_GAS = 100_000;

    /// Zero switches the router's check off. A nonzero address must answer
    /// isContractEnforced within REGISTRY_GAS (checked here), so a typo cannot
    /// stop every swap. It cannot prove the registry keeps answering later.
    function setThreatRegistry(address registry) external onlyGov {
        if (registry != address(0)) {
            (bool ok, bytes memory r) = registry.staticcall{gas: REGISTRY_GAS}(abi.encodeCall(IThreatRegistryView.isContractEnforced, (address(this))));
            if (!ok || r.length < 64) revert NotARegistry();
        }
        threatRegistry = registry;
        emit ThreatRegistrySet(registry);
    }

    function setGovernance(address next) external onlyGov {
        pendingGovernance = next;
        emit GovernanceProposed(next);
    }

    function acceptGovernance() external {
        if (msg.sender != pendingGovernance) revert NotPendingGovernance();
        governance = msg.sender;
        pendingGovernance = address(0);
        emit GovernanceSet(msg.sender);
    }
}
