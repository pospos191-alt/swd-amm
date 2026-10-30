// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

interface IZkIdentity {
    function registerScope(uint256 scope) external;
    function verify(uint256 root, uint256 nullifier, uint256 scope, uint256 signalHash, uint256 minLevel, uint256[8] calldata proof)
        external view returns (bool);
}

/// @title PrivateAirdrop: one claim per person, to an address that is not linked to the person (testnet)
/// @notice docs/future/zk-identity.md. Pays `amount` (native coin) once per nullifier of `scope` to the recipient the
///   proof is bound to. The signal is keccak256(recipient, fee) >> 8, so whoever submits the transaction (the person
///   from a fresh address, or any relayer who is paid `fee`) cannot change where the coins go.
///   Uniqueness is the registry's: one claim per registered identity of level >= minLevel.
contract PrivateAirdrop {
    IZkIdentity public immutable registry;
    uint256 public immutable scope;
    uint256 public immutable minLevel;
    uint256 public immutable amount;
    mapping(uint256 => bool) public nullifierUsed;
    uint256 public claims;

    event Claimed(uint256 indexed nullifier, address indexed recipient, address relayer, uint256 fee);
    event Funded(address from, uint256 value);

    error AlreadyClaimed();
    error BadProof();
    error BadFee();
    error Empty();
    error PayFailed();

    constructor(IZkIdentity registry_, uint256 scope_, uint256 minLevel_, uint256 amount_) payable {
        registry = registry_;
        scope = scope_;
        minLevel = minLevel_;
        amount = amount_;
        registry_.registerScope(scope_);
    }

    receive() external payable {
        emit Funded(msg.sender, msg.value);
    }

    /// The signal a claim's proof must carry.
    function signalOf(address recipient, uint256 fee) public pure returns (uint256) {
        return uint256(keccak256(abi.encode(recipient, fee))) >> 8;
    }

    function claim(address recipient, uint256 fee, uint256 root, uint256 nullifier, uint256[8] calldata proof) external {
        if (nullifierUsed[nullifier]) revert AlreadyClaimed();
        if (fee > amount) revert BadFee();
        if (address(this).balance < amount) revert Empty();
        if (!registry.verify(root, nullifier, scope, signalOf(recipient, fee), minLevel, proof)) revert BadProof();
        nullifierUsed[nullifier] = true;
        claims++;
        emit Claimed(nullifier, recipient, msg.sender, fee);
        (bool ok, ) = recipient.call{value: amount - fee}("");
        if (!ok) revert PayFailed();
        if (fee != 0) {
            (ok, ) = msg.sender.call{value: fee}("");
            if (!ok) revert PayFailed();
        }
    }
}
