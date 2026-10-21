// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// Test-only contracts (compiled by test/helpers/chain.js, never deployed for real).

import {ZetaphyERC721} from "../../contracts/ZetaphyERC721.sol";
import {CollectionConfig} from "../../contracts/CollectionBase.sol";
import {IERC721Receiver, IERC1155Receiver, IERC165} from "../../contracts/interfaces/Interfaces.sol";

interface IMarket {
    function buy(uint256 id, uint256 quantity) external payable;
    function withdraw() external;
    function cancelOffer(uint256 id) external;
    function acceptOffer(uint256 id, uint256 minProceeds) external;
    function makeOffer(address c, uint256 tokenId, uint256 q, uint64 expiry) external payable returns (uint256);
}

/// A stand-in for ThreatRegistry's read side, with the same keys (addressKey,
/// codeKey, fp1 fingerprints) and the same warning / enforcement views.
contract MockThreatRegistry {
    bytes32 public constant EMPTY_CODEHASH = 0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470;
    mapping(bytes32 => uint8) public flaggedReason;  // 0: not flagged
    mapping(bytes32 => uint8) public enforcedReason; // 0: not enforced
    bool public broken;

    function codeKey(bytes32 h) public pure returns (bytes32) { return keccak256(abi.encode("zetaphy.threat.code", h)); }
    function addressKey(uint256 chainId, address who) public pure returns (bytes32) { return keccak256(abi.encode("zetaphy.threat.address", chainId, who)); }

    /// Any key: flagged reason (warning) and enforced reason (0 = none).
    function setKey(bytes32 key, uint8 flagged, uint8 enforced) public {
        flaggedReason[key] = flagged;
        enforcedReason[key] = enforced;
    }

    /// The address key of `who` on this chain.
    function set(address who, uint8 flagged, uint8 enforced) external {
        setKey(addressKey(block.chainid, who), flagged, enforced);
    }

    function setBroken(bool b) external { broken = b; }

    function isFlagged(bytes32 k) public view returns (bool, uint8) {
        uint8 r = enforcedReason[k] != 0 ? enforcedReason[k] : flaggedReason[k];
        return (r != 0, r);
    }

    function isEnforced(bytes32 k) public view returns (bool, uint8) {
        require(!broken, "registry down");
        return (enforcedReason[k] != 0, enforcedReason[k]);
    }

    function isCodeFlagged(bytes32 h) public view returns (bool, uint8) {
        if (h == bytes32(0) || h == EMPTY_CODEHASH) return (false, 0);
        return isFlagged(codeKey(h));
    }

    function isCodeEnforced(bytes32 h) public view returns (bool, uint8) {
        if (h == bytes32(0) || h == EMPTY_CODEHASH) return (false, 0);
        return isEnforced(codeKey(h));
    }

    function isAddressFlagged(uint256 chainId, address who) public view returns (bool, uint8) { return isFlagged(addressKey(chainId, who)); }
    function isAddressEnforced(uint256 chainId, address who) public view returns (bool, uint8) { return isEnforced(addressKey(chainId, who)); }

    function isContractFlagged(address who) external view returns (bool, uint8) {
        (bool f, uint8 r) = isAddressFlagged(block.chainid, who);
        return f ? (f, r) : isCodeFlagged(who.codehash);
    }

    function isContractEnforced(address who) external view returns (bool, uint8) {
        (bool f, uint8 r) = isAddressEnforced(block.chainid, who);
        return f ? (f, r) : isCodeEnforced(who.codehash);
    }
}

/// A contract recipient. mode 0: accepts; 1: wrong magic value; 2: reverts with a
/// reason; 3: reverts without data.
contract Receiver is IERC721Receiver, IERC1155Receiver {
    uint8 public mode;

    constructor(uint8 m) { mode = m; }

    function setMode(uint8 m) external { mode = m; }

    function _answer(bytes4 ok) private view returns (bytes4) {
        if (mode == 1) return 0xdeadbeef;
        if (mode == 2) revert("receiver says no");
        if (mode == 3) revert();
        return ok;
    }

    function onERC721Received(address, address, uint256, bytes calldata) external view returns (bytes4) {
        return _answer(IERC721Receiver.onERC721Received.selector);
    }

    function onERC1155Received(address, address, uint256, uint256, bytes calldata) external view returns (bytes4) {
        return _answer(IERC1155Receiver.onERC1155Received.selector);
    }

    function onERC1155BatchReceived(address, address, uint256[] calldata, uint256[] calldata, bytes calldata) external view returns (bytes4) {
        return _answer(IERC1155Receiver.onERC1155BatchReceived.selector);
    }

    function supportsInterface(bytes4 id) external pure returns (bool) {
        return id == type(IERC165).interfaceId || id == type(IERC1155Receiver).interfaceId;
    }
}

/// A contract with no receiver hooks at all.
contract NotAReceiver {
    function ping() external pure returns (uint256) { return 1; }
}

/// Buys through the marketplace; when the NFT arrives it tries to buy again
/// (another listing) and records how the reentrant call failed.
contract ReentrantBuyer is IERC721Receiver {
    IMarket public immutable market;
    uint256 public nextId;
    uint256 public nextPrice;
    bytes public reentryError;
    bool public reentered;

    constructor(IMarket m) { market = m; }

    function buy(uint256 id, uint256 price, uint256 next, uint256 nextPrice_) external payable {
        nextId = next;
        nextPrice = nextPrice_;
        market.buy{value: price}(id, 1);
    }

    function onERC721Received(address, address, uint256, bytes calldata) external returns (bytes4) {
        if (!reentered) {
            reentered = true;
            try market.buy{value: nextPrice}(nextId, 1) {} catch (bytes memory e) { reentryError = e; }
        }
        return IERC721Receiver.onERC721Received.selector;
    }

    receive() external payable {}
}

/// Owed money by the marketplace; on receiving it, tries to withdraw again.
contract ReentrantPayee {
    IMarket public immutable market;
    bytes public reentryError;
    uint256 public received;

    constructor(IMarket m) { market = m; }

    function pull() external { market.withdraw(); }

    function offer(address c, uint256 tokenId, uint64 expiry) external payable returns (uint256) {
        return market.makeOffer{value: msg.value}(c, tokenId, 1, expiry);
    }

    function cancel(uint256 id) external { market.cancelOffer(id); }

    receive() external payable {
        received += msg.value;
        try market.withdraw() {} catch (bytes memory e) { reentryError = e; }
    }
}

/// Refuses every payment (a seller that cannot take ZETAPHY directly).
contract RefusingPayee {
    function cancel(IMarket m, uint256 id) external { m.cancelOffer(id); }

    function offer(IMarket m, address c, uint256 tokenId, uint64 expiry) external payable returns (uint256) {
        return m.makeOffer{value: msg.value}(c, tokenId, 1, expiry);
    }

    function withdrawTo(address market, address to) external {
        (bool ok, bytes memory e) = market.call(abi.encodeWithSignature("withdrawTo(address)", to));
        if (!ok) assembly { revert(add(e, 32), mload(e)) }
    }

    function withdraw(address market) external {
        (bool ok, bytes memory e) = market.call(abi.encodeWithSignature("withdraw()"));
        if (!ok) assembly { revert(add(e, 32), mload(e)) }
    }
}

/// An ERC-721 whose transfers call back into the marketplace (a hostile collection).
contract EvilCollection is ZetaphyERC721 {
    IMarket public market;
    uint8 public attack; // 1: buy, 2: acceptOffer, 3: cancelOffer, 4: withdraw
    uint256 public arg;
    bytes public reentryError;

    constructor(CollectionConfig memory c) ZetaphyERC721(c, msg.sender) {}

    function arm(IMarket m, uint8 a, uint256 x) external { market = m; attack = a; arg = x; }

    function safeTransferFromHook() private {
        if (attack == 0) return;
        uint8 a = attack;
        attack = 0;
        bool ok;
        bytes memory e;
        if (a == 1) (ok, e) = address(market).call(abi.encodeWithSelector(IMarket.buy.selector, arg, 1));
        else if (a == 2) (ok, e) = address(market).call(abi.encodeWithSelector(IMarket.acceptOffer.selector, arg, 0));
        else if (a == 3) (ok, e) = address(market).call(abi.encodeWithSelector(IMarket.cancelOffer.selector, arg));
        else (ok, e) = address(market).call(abi.encodeWithSelector(IMarket.withdraw.selector));
        reentryError = ok ? bytes("ok") : e;
    }

    function safeTransferFrom(address from, address to, uint256 tokenId) external override {
        safeTransferFromHook();
        safeTransferFrom(from, to, tokenId, "");
    }
}

/// Royalty answers a collection might give: mode 1: 100% of the price; 2: reverts;
/// 3: a dirty address word; 4: short answer; 5: burns all gas; 6: a proper 10%
/// answer that needs ~30k gas (legitimate, but starvable without the gas floor).
contract WeirdRoyalty721 is ZetaphyERC721 {
    uint8 public mode;

    constructor(CollectionConfig memory c, uint8 m) ZetaphyERC721(c, msg.sender) { mode = m; }

    function royaltyInfo(uint256, uint256 salePrice) external view override returns (address, uint256) {
        if (mode == 1) return (owner, salePrice);
        if (mode == 2) revert("no");
        if (mode == 3) assembly { mstore(0, not(0)) mstore(32, 5) return(0, 64) }
        if (mode == 4) assembly { mstore(0, 1) return(0, 31) }
        if (mode == 5) { uint256 x; while (true) { x++; } }
        if (mode == 6) {
            uint256 g = gasleft();
            while (g - gasleft() < 30_000) {}
            return (owner, salePrice / 10);
        }
        return (owner, 0);
    }
}

/// Says it is an ERC-721, but transfers do nothing.
contract FakeNFT {
    address public holder;
    mapping(address => mapping(address => bool)) public isApprovedForAll;

    constructor() { holder = msg.sender; }

    function supportsInterface(bytes4 id) external pure returns (bool) {
        return id == 0x01ffc9a7 || id == 0x80ac58cd;
    }

    function ownerOf(uint256) external view returns (address) { return holder; }
    function getApproved(uint256) external pure returns (address) { return address(0); }
    function setApprovalForAll(address op, bool on) external { isApprovedForAll[msg.sender][op] = on; }
    function safeTransferFrom(address, address, uint256) external {}
}

/// Answers supportsInterface(0xffffffff) with true (not ERC-165 compliant).
contract BadERC165 {
    function supportsInterface(bytes4) external pure returns (bool) { return true; }
}

/// Forces ZETAPHY into any address (selfdestruct in the creating transaction still
/// sends its balance under EIP-6780), as a griefer would to block renounceOwnership.
contract ForceSend {
    constructor(address payable to) payable {
        selfdestruct(to);
    }
}

/// A royalty receiver that can take ZETAPHY but has no way to call withdraw.
contract PassiveReceiver {
    receive() external payable {}
}
