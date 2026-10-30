// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title SimpleMultisig: k-of-n owners for ZETAPHY admin roles (testnet)
/// @notice Holds governance of BridgeGuard / BridgeAirlock / StableGateway so
///         that no single key can change limits, prices or lanes. Any owner
///         proposes a call; it runs once `threshold` owners confirmed it.
///         Owners and the threshold change only through the multisig itself.
///         Changing them (setOwners) starts a new owner epoch: every proposal
///         made under an older owner set can no longer be confirmed or
///         executed (SM-1: a removed owner's confirmation must not count, and a
///         lowered threshold must not apply to old proposals). Re-propose it.
///         On mainnet prefer an audited Safe; this is small on purpose.
contract SimpleMultisig {
    struct Proposal {
        address to;
        uint256 value;
        bytes data;
        bool executed;
        uint8 confirmations;
    }

    address[] public owners;
    mapping(address => bool) public isOwner;
    uint8 public threshold;
    Proposal[] public proposals;
    mapping(uint256 => mapping(address => bool)) public confirmed;
    uint256 public ownersEpoch;                      // bumped by every setOwners
    mapping(uint256 => uint256) public proposalEpoch; // proposal id -> owner epoch it was made in

    event Proposed(uint256 indexed id, address indexed by, address to, uint256 value);
    event Confirmed(uint256 indexed id, address indexed by);
    event Revoked(uint256 indexed id, address indexed by);
    event Executed(uint256 indexed id);

    error NotOwner();
    error BadConfig();
    error Done();
    error Twice();
    error NotEnough();
    error CallFailed(bytes reason);
    error Stale();

    constructor(address[] memory owners_, uint8 threshold_) {
        _setOwners(owners_, threshold_);
    }

    receive() external payable {}

    modifier onlyOwner() { if (!isOwner[msg.sender]) revert NotOwner(); _; }

    function propose(address to, uint256 value, bytes calldata data) external onlyOwner returns (uint256 id) {
        id = proposals.length;
        proposals.push(Proposal(to, value, data, false, 0));
        proposalEpoch[id] = ownersEpoch;
        emit Proposed(id, msg.sender, to, value);
        _confirm(id);
    }

    function confirm(uint256 id) external onlyOwner { _confirm(id); }

    function revoke(uint256 id) external onlyOwner {
        Proposal storage p = proposals[id];
        if (p.executed) revert Done();
        if (!confirmed[id][msg.sender]) revert NotEnough();
        confirmed[id][msg.sender] = false;
        p.confirmations -= 1;
        emit Revoked(id, msg.sender);
    }

    function execute(uint256 id) external onlyOwner returns (bytes memory) {
        Proposal storage p = proposals[id];
        if (p.executed) revert Done();
        if (proposalEpoch[id] != ownersEpoch) revert Stale();
        if (p.confirmations < threshold) revert NotEnough();
        p.executed = true;
        (bool ok, bytes memory ret) = p.to.call{value: p.value}(p.data);
        if (!ok) revert CallFailed(ret);
        emit Executed(id);
        return ret;
    }

    /// Change owners / threshold: only as a proposal executed by the multisig.
    function setOwners(address[] calldata owners_, uint8 threshold_) external {
        if (msg.sender != address(this)) revert NotOwner();
        for (uint256 i = 0; i < owners.length; i++) isOwner[owners[i]] = false;
        _setOwners(owners_, threshold_);
        ownersEpoch += 1;   // older proposals (and their confirmations) are void
    }

    function ownerCount() external view returns (uint256) { return owners.length; }
    function proposalCount() external view returns (uint256) { return proposals.length; }

    function _confirm(uint256 id) private {
        Proposal storage p = proposals[id];
        if (p.executed) revert Done();
        if (proposalEpoch[id] != ownersEpoch) revert Stale();
        if (confirmed[id][msg.sender]) revert Twice();
        confirmed[id][msg.sender] = true;
        p.confirmations += 1;
        emit Confirmed(id, msg.sender);
    }

    function _setOwners(address[] memory owners_, uint8 threshold_) private {
        if (threshold_ < 2 || threshold_ > owners_.length || owners_.length > 20) revert BadConfig();
        delete owners;
        for (uint256 i = 0; i < owners_.length; i++) {
            address o = owners_[i];
            if (o == address(0) || isOwner[o]) revert BadConfig();
            isOwner[o] = true;
            owners.push(o);
        }
        threshold = threshold_;
    }
}
