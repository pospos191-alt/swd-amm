// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

interface IMockRecipient {
    function handle(uint32 origin, bytes32 sender, bytes calldata message) external payable;
}

/// @title MockMailbox: TEST ONLY stand-in for a Hyperlane v3 Mailbox
/// @notice dispatch() records the message (and charges `fee`); deliver() plays
///         the relayer + ISM on the destination: it calls handle() as the real
///         Mailbox does after its ISM verified the message. Anyone may deliver
///         anything here: it stands for a Mailbox, never use it on a real chain.
contract MockMailbox {
    uint32 public immutable localDomain;
    uint256 public fee;
    uint32 public nonce;

    address public lastHook;   // the custom hook of the last dispatch (zero = default)

    event Dispatch(address indexed sender, uint32 indexed destination, bytes32 indexed recipient, bytes message);

    constructor(uint32 localDomain_) { localDomain = localDomain_; }

    function setFee(uint256 f) external { fee = f; }

    function quoteDispatch(uint32, bytes32, bytes calldata) external view returns (uint256) { return fee; }

    function quoteDispatch(uint32, bytes32, bytes calldata, bytes calldata, address) external view returns (uint256) { return fee; }

    function dispatch(uint32 destination, bytes32 recipient, bytes calldata body, bytes calldata, address hook) external payable returns (bytes32 id) {
        lastHook = hook;
        return _dispatch(destination, recipient, body);
    }

    function dispatch(uint32 destination, bytes32 recipient, bytes calldata body) external payable returns (bytes32 id) {
        lastHook = address(0);
        return _dispatch(destination, recipient, body);
    }

    function _dispatch(uint32 destination, bytes32 recipient, bytes calldata body) private returns (bytes32 id) {
        require(msg.value >= fee, "fee");
        id = keccak256(abi.encode(localDomain, nonce++, msg.sender, destination, recipient, body));
        emit Dispatch(msg.sender, destination, recipient, body);
    }

    function deliver(uint32 origin, bytes32 sender, address recipient, bytes calldata body) external {
        IMockRecipient(recipient).handle(origin, sender, body);
    }
}
