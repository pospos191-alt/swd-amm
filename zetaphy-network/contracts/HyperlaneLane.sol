// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// Minimal local copies of Hyperlane v3 interfaces (no Hyperlane package offline).
// Checked against hyperlane-xyz/hyperlane-monorepo at commit
// bc8cfcec461930ec005590bc838871f903a297a1 (main, 2026-10-21):
//   solidity/contracts/interfaces/IMailbox.sol             dispatch / quoteDispatch / localDomain
//   solidity/contracts/interfaces/IMessageRecipient.sol    handle(uint32, bytes32, bytes) payable
//   solidity/contracts/interfaces/IInterchainSecurityModule.sol  moduleType / verify, and
//     ISpecifiesInterchainSecurityModule.interchainSecurityModule()
// The Mailbox calls recipient.handle{value: msg.value}(origin, sender, body) after
// its ISM (the recipient's interchainSecurityModule(), or the Mailbox default when
// that is zero) verified the message.

interface IHyperlaneMailbox {
    function localDomain() external view returns (uint32);
    function dispatch(uint32 destinationDomain, bytes32 recipientAddress, bytes calldata messageBody) external payable returns (bytes32 messageId);
    function quoteDispatch(uint32 destinationDomain, bytes32 recipientAddress, bytes calldata messageBody) external view returns (uint256 fee);
}

interface IInterchainSecurityModule {
    function moduleType() external view returns (uint8);
    function verify(bytes calldata metadata, bytes calldata message) external returns (bool);
}

interface IMessageRecipient {
    function handle(uint32 origin, bytes32 sender, bytes calldata message) external payable;
}

/// BridgeAirlock as a lane sees it.
interface IAirlockLane {
    function attest(uint256 srcChainId, address srcContract, uint256 srcNonce, address sender, address to, uint256 amount) external;
    function transferId(uint256 srcChainId, address srcContract, uint256 srcNonce, address sender, address to, uint256 amount) external pure returns (bytes32);
}

/// @title HyperlaneLane: Hyperlane as one of BridgeAirlock's lanes (ZETAPHY side)
/// @notice Independent of NeuroLane: what it attests is decided by Hyperlane's
///         Mailbox and the ISM (validator set) that secures it, not by Neuro
///         runners. It accepts a message only
///           - from the configured Mailbox (msg.sender),
///           - from the configured origin domain and origin sender (the source
///             chain's HyperlaneLockBox, or a router speaking for it),
///           - describing a deposit of the configured source chain and contract;
///         and each transfer once. It then attests to the airlock exactly the
///         fields NeuroLane attests for the same deposit, so both lanes produce
///         the same transfer id: (srcChainId, srcContract, srcNonce, sender, to, amount).
///         Body: abi.encode(uint256 srcChainId, address srcContract, uint256 srcNonce,
///         address sender, address to, uint256 amount), 192 bytes.
///         Governance (a multisig) sets the config and an optional custom ISM;
///         until the source is configured every message is refused.
contract HyperlaneLane is IMessageRecipient {
    IAirlockLane public immutable airlock;
    address public governance;
    address public mailbox;
    uint32 public originDomain;
    bytes32 public originSender;
    uint256 public srcChainId;
    address public srcContract;
    /// Hyperlane reads this (ISpecifiesInterchainSecurityModule); zero = the Mailbox's default ISM.
    IInterchainSecurityModule public interchainSecurityModule;
    mapping(bytes32 => bool) public delivered;   // by transfer id: replay protection

    event ConfigSet(address mailbox, uint32 originDomain, bytes32 originSender, uint256 srcChainId, address srcContract);
    event IsmSet(address ism);
    event GovernanceSet(address governance);
    event Delivered(bytes32 indexed id, uint256 indexed srcNonce, address sender, address to, uint256 amount);

    error NotGovernance();
    error NotMailbox();
    error WrongOrigin(uint32 origin);
    error WrongSender(bytes32 sender);
    error WrongSource();
    error BadBody();
    error Replay(bytes32 id);
    error NoValue();

    constructor(IAirlockLane airlock_, address governance_, address mailbox_, uint32 originDomain_, bytes32 originSender_,
        uint256 srcChainId_, address srcContract_, IInterchainSecurityModule ism_)
    {
        require(address(airlock_) != address(0) && governance_ != address(0) && mailbox_ != address(0), "config");
        airlock = airlock_;
        governance = governance_;
        _config(mailbox_, originDomain_, originSender_, srcChainId_, srcContract_);
        interchainSecurityModule = ism_;
        emit IsmSet(address(ism_));
    }

    modifier onlyGov() { if (msg.sender != governance) revert NotGovernance(); _; }

    /// The Mailbox decides what this lane attests (BridgeAirlock.independentLanes).
    function laneController() external view returns (address) { return mailbox; }

    function setConfig(address mailbox_, uint32 originDomain_, bytes32 originSender_, uint256 srcChainId_, address srcContract_) external onlyGov {
        require(mailbox_ != address(0), "mailbox");
        _config(mailbox_, originDomain_, originSender_, srcChainId_, srcContract_);
    }

    function setInterchainSecurityModule(IInterchainSecurityModule ism) external onlyGov {
        interchainSecurityModule = ism;
        emit IsmSet(address(ism));
    }

    function setGovernance(address g) external onlyGov {
        require(g != address(0), "governance");
        governance = g;
        emit GovernanceSet(g);
    }

    function handle(uint32 origin, bytes32 sender, bytes calldata body) external payable {
        if (msg.sender != mailbox) revert NotMailbox();
        if (msg.value != 0) revert NoValue();
        if (origin != originDomain) revert WrongOrigin(origin);
        if (sender != originSender || sender == bytes32(0)) revert WrongSender(sender);
        if (body.length != 192) revert BadBody();
        (uint256 chain, address src, uint256 nonce, address from, address to, uint256 amount) =
            abi.decode(body, (uint256, address, uint256, address, address, uint256));
        if (chain != srcChainId || src != srcContract || src == address(0)) revert WrongSource();
        bytes32 id = airlock.transferId(chain, src, nonce, from, to, amount);
        if (delivered[id]) revert Replay(id);
        delivered[id] = true;
        emit Delivered(id, nonce, from, to, amount);
        airlock.attest(chain, src, nonce, from, to, amount);
    }

    function _config(address mailbox_, uint32 originDomain_, bytes32 originSender_, uint256 srcChainId_, address srcContract_) private {
        mailbox = mailbox_;
        originDomain = originDomain_;
        originSender = originSender_;
        srcChainId = srcChainId_;
        srcContract = srcContract_;
        emit ConfigSet(mailbox_, originDomain_, originSender_, srcChainId_, srcContract_);
    }
}

/// @title HyperlaneLockBox: the source-chain side, for both lanes at once
/// @notice Locks native coin, emits LockBox's `Locked` event (the Neuro runners
///         watch it, unchanged: `zetaphy bridge watch --lockbox <this>`) and
///         dispatches the same transfer through the Hyperlane Mailbox to the
///         HyperlaneLane on ZETAPHY. msg.value = amount + the Mailbox fee
///         (quoteLock). Like LockBox it has no refund path: a vetoed or held
///         transfer stays locked here.
contract HyperlaneLockBox {
    IHyperlaneMailbox public immutable mailbox;
    uint32 public immutable destinationDomain;
    bytes32 public immutable recipient;      // HyperlaneLane on ZETAPHY
    uint256 public nonce;

    event Locked(uint256 indexed nonce, address indexed sender, address indexed to, uint256 amount);
    event Dispatched(uint256 indexed nonce, bytes32 messageId);

    constructor(IHyperlaneMailbox mailbox_, uint32 destinationDomain_, bytes32 recipient_) {
        require(address(mailbox_) != address(0) && recipient_ != bytes32(0), "config");
        mailbox = mailbox_;
        destinationDomain = destinationDomain_;
        recipient = recipient_;
    }

    function body(uint256 n, address sender, address to, uint256 amount) public view returns (bytes memory) {
        return abi.encode(block.chainid, address(this), n, sender, to, amount);
    }

    /// The Mailbox fee for the next lock (pay amount + this).
    function quoteLock(address to, uint256 amount) external view returns (uint256) {
        return mailbox.quoteDispatch(destinationDomain, recipient, body(nonce, msg.sender, to, amount));
    }

    function lock(address to, uint256 amount) external payable returns (bytes32 messageId) {
        require(amount > 0 && to != address(0) && msg.value >= amount, "lock");
        uint256 n = nonce++;
        emit Locked(n, msg.sender, to, amount);
        messageId = mailbox.dispatch{value: msg.value - amount}(destinationDomain, recipient, body(n, msg.sender, to, amount));
        emit Dispatched(n, messageId);
    }
}
