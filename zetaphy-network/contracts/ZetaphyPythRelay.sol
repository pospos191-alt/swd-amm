// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice The part of Pyth's IPyth (pyth-sdk-solidity) ZETAPHY reads and writes,
///         with Pyth's own struct layout (PythStructs.Price / PriceFeed): the
///         ABI is the same as the real Pyth contract's, so ZetaphyOracle can be
///         pointed at real Pyth later (ZetaphyOracle.setPyth, through the timelock).
interface IPythLike {
    struct Price {
        int64 price;
        uint64 conf;
        int32 expo;
        uint256 publishTime;
    }
    struct PriceFeed {
        bytes32 id;
        Price price;
        Price emaPrice;
    }
    function getPriceUnsafe(bytes32 id) external view returns (Price memory);
    function getPriceNoOlderThan(bytes32 id, uint256 age) external view returns (Price memory);
    function getEmaPriceUnsafe(bytes32 id) external view returns (Price memory);
    function priceFeedExists(bytes32 id) external view returns (bool);
    function getUpdateFee(bytes[] calldata updateData) external view returns (uint256);
    function updatePriceFeeds(bytes[] calldata updateData) external payable;
}

/// @title ZetaphyPythRelay: Pyth prices on ZETAPHY before Pyth itself is here
/// @notice Pyth has no contract on ZETAPHY yet. Real Pyth checks each update
///         against Wormhole guardian signatures; this relay instead accepts an
///         update only when `threshold` distinct relayers (keys governance names)
///         submitted exactly the same one. Updates use Pyth's public format, the
///         one Pyth's MockPyth.createPriceFeedUpdateData builds:
///             abi.encode(PythStructs.PriceFeed feed, uint64 prevPublishTime)
///         so a relayer forwards what it reads from Pyth (Hermes) unchanged.
///         Like Pyth: an older update than the stored one is ignored (not an
///         error), the PriceFeedUpdate event is Pyth's, and reads revert with
///         PriceFeedNotFound / StalePrice. Unlike Pyth: the update fee is 0 and
///         sending value is refused.
///         Trust: the relayers (and governance, which names them) can publish any
///         price. ZetaphyOracle does not trust it alone: it checks staleness, the
///         confidence interval, the deviation from the DEX TWAP and a circuit
///         breaker. Later, either point ZetaphyOracle at real Pyth, or make a
///         Hyperlane receiver (a contract whose handle() takes Pyth updates from
///         a Hyperlane message out of a chain where Pyth verified them) the only
///         relayer, with threshold 1. Docs: zetaphy-network/README.md (oracle).
///         Governance: the ZetaphyTimelock.
contract ZetaphyPythRelay is IPythLike {
    address public governance;
    mapping(address => bool) public isRelayer;
    uint256 public relayerCount;
    uint8 public threshold;
    /// The furthest in the future a publishTime may be (clock skew).
    uint256 public constant MAX_FUTURE = 60;

    mapping(bytes32 => PriceFeed) private _feeds;
    /// keccak256(update) => relayer => submitted (an update is accepted once threshold relayers sent it)
    mapping(bytes32 => mapping(address => bool)) public submitted;
    mapping(bytes32 => uint8) public submissions;

    event PriceFeedUpdate(bytes32 indexed id, uint64 publishTime, int64 price, uint64 conf);
    event RelayerSet(address indexed relayer, bool on);
    event ThresholdSet(uint8 threshold);
    event GovernanceSet(address governance);
    event Submitted(bytes32 indexed id, bytes32 indexed update, address indexed relayer, uint8 count);

    error NotGovernance();
    error NotRelayer();
    error PriceFeedNotFound();
    error StalePrice();
    error InvalidUpdateData();
    error NoFee();

    constructor(address governance_, address[] memory relayers, uint8 threshold_) {
        require(governance_ != address(0), "governance");
        governance = governance_;
        for (uint256 i = 0; i < relayers.length; i++) _setRelayer(relayers[i], true);
        require(threshold_ >= 1, "threshold");
        threshold = threshold_;
        emit GovernanceSet(governance_);
        emit ThresholdSet(threshold_);
    }

    modifier onlyGov() { if (msg.sender != governance) revert NotGovernance(); _; }

    function setRelayer(address who, bool on) external onlyGov { _setRelayer(who, on); }
    function setThreshold(uint8 t) external onlyGov { require(t >= 1, "threshold"); threshold = t; emit ThresholdSet(t); }
    function setGovernance(address g) external onlyGov { require(g != address(0), "governance"); governance = g; emit GovernanceSet(g); }

    function _setRelayer(address who, bool on) private {
        require(who != address(0), "relayer");
        if (on != isRelayer[who]) { if (on) relayerCount += 1; else relayerCount -= 1; }
        isRelayer[who] = on;
        emit RelayerSet(who, on);
    }

    // ---- Pyth's interface ----

    function getUpdateFee(bytes[] calldata) external pure returns (uint256) { return 0; }

    function updatePriceFeeds(bytes[] calldata updateData) external payable {
        if (msg.value != 0) revert NoFee();
        if (!isRelayer[msg.sender]) revert NotRelayer();
        for (uint256 i = 0; i < updateData.length; i++) {
            (PriceFeed memory f, ) = abi.decode(updateData[i], (PriceFeed, uint64));
            if (f.id == bytes32(0) || f.price.publishTime > block.timestamp + MAX_FUTURE) revert InvalidUpdateData();
            if (f.price.publishTime <= _feeds[f.id].price.publishTime) continue; // older or same: ignored, as Pyth does
            bytes32 u = keccak256(updateData[i]);
            if (!submitted[u][msg.sender]) {
                submitted[u][msg.sender] = true;
                submissions[u] += 1;
                emit Submitted(f.id, u, msg.sender, submissions[u]);
            }
            if (submissions[u] < threshold) continue;
            _feeds[f.id] = f;
            emit PriceFeedUpdate(f.id, uint64(f.price.publishTime), f.price.price, f.price.conf);
        }
    }

    function priceFeedExists(bytes32 id) public view returns (bool) { return _feeds[id].price.publishTime != 0; }

    function getPriceUnsafe(bytes32 id) public view returns (Price memory) {
        if (!priceFeedExists(id)) revert PriceFeedNotFound();
        return _feeds[id].price;
    }

    function getEmaPriceUnsafe(bytes32 id) external view returns (Price memory) {
        if (!priceFeedExists(id)) revert PriceFeedNotFound();
        return _feeds[id].emaPrice;
    }

    function getPriceNoOlderThan(bytes32 id, uint256 age) external view returns (Price memory p) {
        p = getPriceUnsafe(id);
        if (block.timestamp > p.publishTime && block.timestamp - p.publishTime > age) revert StalePrice();
    }
}
