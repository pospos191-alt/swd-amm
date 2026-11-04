// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title ZETAPHY Saphan accounts: one account address on every Saphan chain, controlled from ZETAPHY
/// @notice Saphan PR 5 (docs/SAPHAN-PR5.md), testnet only, not audited.
///
///         SaphanAccountFactory sits at the same address on every Saphan chain (deployed by one fresh key as its
///         first transaction there, so CREATE gives the same address whatever its constructor arguments). Each user
///         (an address on ZETAPHY, the "owner") has one SaphanAccount per chain, made with CREATE2 (salt = owner,
///         init code = SaphanAccount + owner): the same factory and the same init code give the same address on every
///         chain. src/saphanaccounts.js derives it off-chain. Anyone may deploy it (deploy(owner)); it is the
///         owner's either way.
///
///         Who controls it:
///           - on ZETAPHY (the home chain): the owner, directly (execute);
///           - on any other chain: only the owner's calls from ZETAPHY through that chain's Saphan Gateway:
///             ZetaphyGateway.withdrawAndCall(target = the account, data = abi.encode(Call[])). The SaphanSourceGateway
///             there calls account.onSaphanCall(77390, owner, data) with the ETH, after the route's checks; the
///             account checks the Gateway, the chain and the owner, then runs the calls (all or none: a failure makes
///             the Gateway refund the ETH to revertTo, normally the account itself).
///         The owner's key is never used on the other chains: a contract owner on ZETAPHY (a multisig, a
///         QuantumWallet) controls its accounts everywhere the same way, and the same address on another chain
///         controlled by someone else has no power over them.

interface IAccountFactory {
    function homeChainId() external view returns (uint256);
    function gateway() external view returns (address);
}

/// SaphanSourceGateway.claim: ETH of failed calls, paid to the caller.
interface IAccountGateway {
    function claim() external;
}

contract SaphanAccount {
    struct Call {
        address target;
        uint256 value;
        bytes data;
    }

    address public immutable factory;
    address public immutable owner;   // on ZETAPHY
    uint256 private entered;

    event Executed(uint256 calls, uint256 srcChainId);
    event Received(uint256 srcChainId, address sender, address token, uint256 amount);

    error NotOwner();
    error NotGateway();
    error CallFailed(uint256 index, bytes reason);
    error Reentered();

    constructor(address owner_) {
        factory = msg.sender;
        owner = owner_;
    }

    modifier nonReentrant() {
        if (entered == 1) revert Reentered();
        entered = 1;
        _;
        entered = 0;
    }

    /// On ZETAPHY: the owner runs calls from the account.
    function execute(Call[] calldata calls) external payable nonReentrant {
        if (msg.sender != owner || block.chainid != IAccountFactory(factory).homeChainId()) revert NotOwner();
        _run(calls);
        emit Executed(calls.length, block.chainid);
    }

    /// On another chain: the owner's calls from ZETAPHY, through this chain's SaphanSourceGateway (ISaphanReceiver).
    function onSaphanCall(uint256 srcChainId, address sender, bytes calldata data) external payable nonReentrant {
        address gw = IAccountFactory(factory).gateway();
        if (gw == address(0) || msg.sender != gw) revert NotGateway();
        if (srcChainId != IAccountFactory(factory).homeChainId() || sender != owner) revert NotOwner();
        _run(abi.decode(data, (Call[])));
        emit Executed(0, srcChainId);
    }

    /// Anyone: ETH the Gateway keeps for this account (a failed call with revertTo = this account) comes into the
    /// account. It cannot happen inside a Gateway call (the Gateway is locked then), so it is its own transaction.
    function pullRefunds() external nonReentrant {
        address gw = IAccountFactory(factory).gateway();
        if (gw == address(0)) revert NotGateway();
        IAccountGateway(gw).claim();
    }

    /// A refund of a call this account made through the Gateway (ISaphanReceiver): the ETH stays here.
    function onSaphanRevert(address, uint256, bytes calldata) external payable {
        address gw = IAccountFactory(factory).gateway();
        if (gw == address(0) || msg.sender != gw) revert NotGateway();
    }

    /// On ZETAPHY, money sent here from another chain through a ZetaphyGateway (ISaphanCallee): the tokens stay
    /// here; no call runs (only the owner runs calls).
    function onSaphanCall(uint256 srcChainId, address sender, address token, uint256 amount, bytes calldata) external {
        emit Received(srcChainId, sender, token, amount);
    }

    /// The callers checked who asks (owner on ZETAPHY, owner through the Gateway elsewhere); checked again here.
    function _run(Call[] memory calls) private {
        if (msg.sender != owner && msg.sender != IAccountFactory(factory).gateway()) revert NotOwner();
        for (uint256 i = 0; i < calls.length; i++) {
            (bool ok, bytes memory reason) = calls[i].target.call{value: calls[i].value}(calls[i].data);
            if (!ok) revert CallFailed(i, reason);
        }
    }

    receive() external payable {}
}

/// @title SaphanAccountFactory: makes SaphanAccounts at their derived address (the same on every chain)
contract SaphanAccountFactory is IAccountFactory {
    uint256 public immutable homeChainId;   // ZETAPHY (77390 on testnet)
    address public immutable gateway;       // this chain's SaphanSourceGateway (zero on ZETAPHY)

    event Deployed(address indexed owner, address account);

    constructor(uint256 homeChainId_, address gateway_) {
        require(homeChainId_ != 0 && (block.chainid == homeChainId_) == (gateway_ == address(0)), "config");
        homeChainId = homeChainId_;
        gateway = gateway_;
    }

    /// keccak256 of the account's init code: SaphanAccount's creation code followed by abi.encode(owner).
    function accountCodeHash(address owner) public pure returns (bytes32) {
        return keccak256(bytes.concat(type(SaphanAccount).creationCode, abi.encode(owner)));
    }

    /// The owner's account on this chain (and on every chain with this factory address).
    function accountOf(address owner) public view returns (address) {
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), bytes32(uint256(uint160(owner))), accountCodeHash(owner))))));
    }

    /// Anyone: deploys the owner's account here (once; afterwards it returns the address).
    function deploy(address owner) external returns (address account) {
        require(owner != address(0), "owner");
        account = accountOf(owner);
        if (account.code.length > 0) return account;
        address made = address(new SaphanAccount{salt: bytes32(uint256(uint160(owner)))}(owner));
        require(made == account, "derive");
        emit Deployed(owner, account);
    }
}
