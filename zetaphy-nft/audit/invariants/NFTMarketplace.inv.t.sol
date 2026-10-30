// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {NFTMarketplace} from "../../contracts/NFTMarketplace.sol";
import {ZetaphyERC721} from "../../contracts/ZetaphyERC721.sol";
import {ZetaphyERC1155} from "../../contracts/ZetaphyERC1155.sol";
import {CollectionConfig} from "../../contracts/CollectionBase.sol";

contract MarketHandler is Test {
    NFTMarketplace public m;
    ZetaphyERC721 public c721;
    ZetaphyERC1155 public c1155;
    address public creator;
    address[3] public people = [address(0x1001), address(0x1002), address(0x1003)];
    uint256 public splitWrong;     // fee + royalty + seller part != price
    uint256 public notDelivered;   // the buyer did not get the token(s)

    constructor(NFTMarketplace m_, ZetaphyERC721 a, ZetaphyERC1155 b, address creator_) {
        (m, c721, c1155, creator) = (m_, a, b, creator_);
        for (uint256 i; i < 3; i++) {
            vm.deal(people[i], 1e24);
            vm.startPrank(people[i]);
            c721.setApprovalForAll(address(m), true);
            c1155.setApprovalForAll(address(m), true);
            vm.stopPrank();
        }
    }

    function mint721(uint256 to) external {
        vm.prank(creator);
        c721.mint(people[to % 3], "");
    }

    function mint1155(uint256 to, uint256 amount) external {
        vm.prank(creator);
        c1155.mint(people[to % 3], 1, bound(amount, 1, 100));
    }

    function list(uint256 who, uint256 tokenId, bool erc1155, uint256 qty, uint256 price) external {
        address s = people[who % 3];
        vm.prank(s);
        if (erc1155) {
            try m.list(address(c1155), 1, bound(qty, 1, 20), bound(price, 1, 10 ether), uint64(block.timestamp + 1 days)) {} catch {}
        } else {
            try m.list(address(c721), bound(tokenId, 1, 20), 1, bound(price, 1, 10 ether), uint64(block.timestamp + 1 days)) {} catch {}
        }
    }

    function _owed3() internal view returns (uint256 s) {
        for (uint256 i; i < 3; i++) s += m.owed(people[i]);
        s += m.owed(creator) + m.owed(address(0xFEE));
    }

    function buy(uint256 who, uint256 id, uint256 qty) external {
        uint256 n = m.listingCount();
        if (n == 0) return;
        id = id % n;
        NFTMarketplace.Listing memory l = m.getListing(id);
        if (l.quantity == 0) return;
        qty = bound(qty, 1, l.quantity);
        address b = people[who % 3];
        uint256 owedBefore = _owed3();
        uint256 have = l.kind == NFTMarketplace.Kind.ERC721 ? 0 : c1155.balanceOf(b, 1);
        vm.prank(b);
        try m.buy{value: l.unitPrice * qty}(id, qty) {
            if (_owed3() - owedBefore != l.unitPrice * qty) splitWrong++;
            if (l.kind == NFTMarketplace.Kind.ERC721) {
                if (c721.ownerOf(l.tokenId) != b) notDelivered++;
            } else if (b != l.seller && c1155.balanceOf(b, 1) != have + qty) notDelivered++;
        } catch {}
    }

    function offer(uint256 who, uint256 tokenId, bool erc1155, uint256 amount) external {
        vm.prank(people[who % 3]);
        if (erc1155) {
            try m.makeOffer{value: bound(amount, 1, 5 ether)}(address(c1155), 1, 2, uint64(block.timestamp + 1 days)) {} catch {}
        } else {
            try m.makeOffer{value: bound(amount, 1, 5 ether)}(address(c721), bound(tokenId, 1, 20), 1, uint64(block.timestamp + 1 days)) {} catch {}
        }
    }

    function accept(uint256 who, uint256 id) external {
        uint256 n = m.offerCount();
        if (n == 0) return;
        id = id % n;
        NFTMarketplace.Offer memory o = m.getOffer(id);
        uint256 owedBefore = _owed3();
        vm.prank(people[who % 3]);
        try m.acceptOffer(id, 0) {
            if (_owed3() - owedBefore != o.amount) splitWrong++;
        } catch {}
    }

    function cancelOffer(uint256 id) external {
        uint256 n = m.offerCount();
        if (n == 0) return;
        id = id % n;
        vm.prank(m.getOffer(id).buyer);
        try m.cancelOffer(id) {} catch {}
    }

    function cancelListing(uint256 id) external {
        uint256 n = m.listingCount();
        if (n == 0) return;
        id = id % n;
        vm.prank(m.getListing(id).seller);
        try m.cancel(id) {} catch {}
    }

    function withdraw(uint256 who) external {
        address[5] memory all = [people[0], people[1], people[2], creator, address(0xFEE)];
        vm.prank(all[who % 5]);
        try m.withdraw() {} catch {}
    }

    function moveAway(uint256 who, uint256 tokenId) external {
        address s = people[who % 3];
        tokenId = bound(tokenId, 1, 20);
        vm.prank(s);
        try c721.transferFrom(s, people[(who + 1) % 3], tokenId) {} catch {}
    }

    function warp(uint256 s) external { vm.warp(block.timestamp + bound(s, 1, 12 hours)); }
}

contract NFTMarketplaceInvariants is Test {
    NFTMarketplace m;
    MarketHandler h;
    address creator = address(0xC0FFEE);

    function setUp() public {
        vm.warp(1_700_000_000);
        CollectionConfig memory c = CollectionConfig("A", "A", "", "", creator, 500, 0, false, 0);
        ZetaphyERC721 a = new ZetaphyERC721(c, creator);
        ZetaphyERC1155 b = new ZetaphyERC1155(c, creator);
        vm.prank(creator);
        b.create(creator, 1, "");
        m = new NFTMarketplace(address(0x60F), address(0xFEE), 250, address(0), address(0));
        h = new MarketHandler(m, a, b, creator);
        targetContract(address(h));
    }

    /// Escrow: the marketplace holds exactly every credit plus every open offer.
    function invariant_escrow() public view {
        uint256 s;
        for (uint256 i; i < 3; i++) s += m.owed(h.people(i));
        s += m.owed(creator) + m.owed(address(0xFEE));
        uint256 n = m.offerCount();
        for (uint256 i; i < n; i++) s += m.getOffer(i).amount;
        assertEq(address(m).balance, s);
    }

    /// Every sale credits exactly the price (fee + royalty + seller) and delivers the token(s).
    function invariant_sales() public view {
        assertEq(h.splitWrong(), 0);
        assertEq(h.notDelivered(), 0);
    }
}
