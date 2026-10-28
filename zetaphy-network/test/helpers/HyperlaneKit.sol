// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// TEST ONLY: the parts of Hyperlane v3 that decide whether a message is delivered, written
// after hyperlane-xyz/hyperlane-monorepo at commit 1aadbba0696ecf96ed4c06f78c978d08db22c0ad:
//   solidity/contracts/Mailbox.sol            process(): version, destination, delivered once,
//                                              the recipient's ISM (or the default), verify, handle
//   solidity/contracts/libs/Message.sol        the message layout (version 3)
//   solidity/contracts/libs/CheckpointLib.sol  the digest validators sign
//   solidity/contracts/isms/libs/MessageIdMultisigIsmMetadata.sol   the metadata layout
//   solidity/contracts/isms/multisig/AbstractMultisigIsm.sol        verify(): threshold
//     signatures, ordered like the validator list
// so the tests sign real checkpoints (ethers) and the contracts see what the real Mailbox and a
// StaticMessageIdMultisigIsm would hand them. No hooks, no gas payments, no merkle tree: the
// message-id multisig ISM signs (origin, origin merkle tree hook, root, index, message id) and
// checks nothing else, so any root/index the test signs is as good as the real ones.

interface IKitRecipient {
    function handle(uint32 origin, bytes32 sender, bytes calldata message) external payable;
}

interface IKitIsm {
    function verify(bytes calldata metadata, bytes calldata message) external returns (bool);
}

contract KitMailbox {
    uint8 public constant VERSION = 3;
    uint32 public immutable localDomain;
    uint32 public nonce;
    uint256 public fee;
    address public defaultIsm;
    address public lastHook;
    bytes public lastMessage;   // the last message dispatched (what a relayer reads from the Dispatch event)
    mapping(bytes32 => bool) public delivered;

    event Dispatch(address indexed sender, uint32 indexed destination, bytes32 indexed recipient, bytes message);
    event DispatchId(bytes32 indexed messageId);
    event ProcessId(bytes32 indexed messageId);

    constructor(uint32 d) { localDomain = d; }

    function setFee(uint256 f) external { fee = f; }
    function setDefaultIsm(address i) external { defaultIsm = i; }

    function quoteDispatch(uint32, bytes32, bytes calldata) external view returns (uint256) { return fee; }
    function quoteDispatch(uint32, bytes32, bytes calldata, bytes calldata, address) external view returns (uint256) { return fee; }

    function dispatch(uint32 destination, bytes32 recipient, bytes calldata body) external payable returns (bytes32) {
        lastHook = address(0);
        return _dispatch(destination, recipient, body);
    }

    function dispatch(uint32 destination, bytes32 recipient, bytes calldata body, bytes calldata, address hook) external payable returns (bytes32) {
        lastHook = hook;
        return _dispatch(destination, recipient, body);
    }

    function _dispatch(uint32 destination, bytes32 recipient, bytes calldata body) private returns (bytes32 id) {
        require(msg.value >= fee, "fee");
        bytes memory m = abi.encodePacked(VERSION, nonce, localDomain, bytes32(uint256(uint160(msg.sender))), destination, recipient, body);
        nonce += 1;
        lastMessage = m;
        id = keccak256(m);
        emit Dispatch(msg.sender, destination, recipient, m);
        emit DispatchId(id);
    }

    function process(bytes calldata metadata, bytes calldata message) external payable {
        require(uint8(message[0]) == VERSION, "Mailbox: bad version");
        require(uint32(bytes4(message[41:45])) == localDomain, "Mailbox: unexpected destination");
        bytes32 id = keccak256(message);
        require(!delivered[id], "Mailbox: already delivered");
        address recipient = address(uint160(uint256(bytes32(message[45:77]))));
        address ism = defaultIsm;
        (bool ok, bytes memory ret) = recipient.staticcall(abi.encodeWithSignature("interchainSecurityModule()"));
        if (ok && ret.length == 32) { address r = abi.decode(ret, (address)); if (r != address(0)) ism = r; }
        delivered[id] = true;
        emit ProcessId(id);
        require(IKitIsm(ism).verify(metadata, message), "Mailbox: ISM verification failed");
        IKitRecipient(recipient).handle{value: msg.value}(uint32(bytes4(message[5:9])), bytes32(message[9:41]), message[77:]);
    }
}

/// A StaticMessageIdMultisigIsm stand-in: validators and threshold fixed at deploy.
contract KitMessageIdMultisigIsm {
    address[] public validators;
    uint8 public threshold;

    constructor(address[] memory v, uint8 t) { validators = v; threshold = t; }

    function moduleType() external pure returns (uint8) { return 5; } // MESSAGE_ID_MULTISIG

    function validatorsAndThreshold(bytes calldata) external view returns (address[] memory, uint8) { return (validators, threshold); }

    function digest(bytes calldata metadata, bytes calldata message) public pure returns (bytes32) {
        bytes32 domainHash = keccak256(abi.encodePacked(uint32(bytes4(message[5:9])), bytes32(metadata[0:32]), "HYPERLANE"));
        bytes32 inner = keccak256(abi.encodePacked(domainHash, bytes32(metadata[32:64]), uint32(bytes4(metadata[64:68])), keccak256(message)));
        return keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", inner));
    }

    function verify(bytes calldata metadata, bytes calldata message) external view returns (bool) {
        require(threshold > 0, "No MultisigISM threshold present for message");
        require((metadata.length - 68) % 65 == 0, "Invalid signatures length");
        bytes32 d = digest(metadata, message);
        uint256 vi = 0;
        for (uint256 i = 0; i < threshold; ++i) {
            address signer = _recover(d, metadata[68 + i * 65:68 + (i + 1) * 65]);
            while (vi < validators.length && signer != validators[vi]) ++vi;
            require(vi < validators.length, "!threshold");
            ++vi;
        }
        return true;
    }

    function _recover(bytes32 d, bytes calldata sig) private pure returns (address a) {
        bytes32 r = bytes32(sig[0:32]);
        bytes32 s = bytes32(sig[32:64]);
        uint8 v = uint8(sig[64]);
        require(uint256(s) <= 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0, "ECDSA: s");
        a = ecrecover(d, v, r, s);
        require(a != address(0), "ECDSA: invalid signature");
    }
}

/// Never verifies anything (an ISM that refuses every message).
contract KitRefusingIsm {
    function moduleType() external pure returns (uint8) { return 5; }
    function verify(bytes calldata, bytes calldata) external pure returns (bool) { return false; }
}

/// A receiver that refuses ETH (to show a failed payout leaves the release claimable).
contract KitRefusingReceiver {
    receive() external payable { revert("no"); }
}
