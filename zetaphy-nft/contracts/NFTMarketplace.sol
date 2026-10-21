// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC721, IERC1155} from "./interfaces/Interfaces.sol";

/// The ThreatRegistry views the marketplace reads (zetaphy-network/contracts/ThreatRegistry.sol).
interface IThreatRegistryView {
    /// The contract's address on this chain, or its code (extcodehash), has a flag that is enforced.
    function isContractEnforced(address who) external view returns (bool, uint8);
}

/// @title NFTMarketplace: fixed-price listings and offers in native ZETAPHY
/// @notice Escrow-less listings: the NFT stays in the seller's wallet, which approves
///         this contract (setApprovalForAll, or approve for one ERC-721 token); the sale
///         moves it to the buyer. A listing whose seller no longer holds the token (or
///         took back the approval) cannot be bought (`listingStatus` says why).
///         Offers hold the offered ZETAPHY here until accepted or cancelled.
///
///         Every sale pays, from the price:
///           - the protocol fee: feeBps (governance, at most MAX_FEE_BPS = 5%) to feeRecipient;
///           - the EIP-2981 royalty the collection reports, cut at MAX_ROYALTY_BPS (10%)
///             of the price, to its receiver (0 if the collection has none, or its
///             royaltyInfo fails or answers nonsense);
///           - the rest to the seller.
///         All rounding is down, so the seller gets any dust. Payments are credited
///         (`owed`) and taken with withdraw / withdrawTo: a receiver that refuses ZETAPHY
///         cannot block a sale.
///
///         Neuro: when governance has set `threatRegistry` (zero = off), listing, buying,
///         offering and accepting refuse a collection whose address or code has an
///         ENFORCED flag (ThreatRegistry.isContractEnforced). Cancelling and withdrawing
///         always work. A flag states a reproducible fact about code, not an accusation.
contract NFTMarketplace {
    enum Kind { None, ERC721, ERC1155 }

    /// Why a listing cannot be bought now (listingStatus).
    enum Status { Ok, Inactive, Expired, SellerCancelledAll, SellerLacksToken, NotApproved, Refused }

    struct Listing {
        address seller;
        uint64 expiry;
        Kind kind;
        address collection;
        uint64 nonce;      // the seller's nonce when listed; cancelAll() bumps it
        uint256 tokenId;
        uint256 unitPrice; // wei per unit (ERC-721: the price)
        uint256 quantity;  // units still for sale (0: sold out or cancelled)
    }

    struct Offer {
        address buyer;
        uint64 expiry;
        Kind kind;
        address collection;
        uint256 tokenId;
        uint256 quantity;  // units wanted (ERC-721: 1), all at once
        uint256 amount;    // wei held for the whole offer (0: closed)
    }

    uint16 public constant MAX_FEE_BPS = 500;      // 5%
    uint16 public constant MAX_ROYALTY_BPS = 1000; // 10%
    uint64 public constant MAX_DURATION = 365 days;
    uint256 private constant PROBE_GAS = 30_000;   // supportsInterface, per EIP-165
    uint256 private constant ROYALTY_GAS = 50_000;

    address public governance;
    address public feeRecipient;
    uint16 public feeBps;
    address public threatRegistry;

    Listing[] private _listings;
    Offer[] private _offers;
    mapping(address => uint64) public nonceOf;
    mapping(address => uint256) public owed;
    uint256 private _lock = 1;

    event Listed(uint256 indexed id, address indexed seller, address indexed collection, uint256 tokenId, uint256 quantity, uint256 unitPrice, uint64 expiry);
    event Cancelled(uint256 indexed id);
    event CancelledAll(address indexed seller, uint64 nonce);
    event Sold(uint256 indexed id, address indexed buyer, address indexed collection, uint256 tokenId, uint256 quantity, uint256 price, uint256 fee, uint256 royalty);
    event OfferMade(uint256 indexed id, address indexed buyer, address indexed collection, uint256 tokenId, uint256 quantity, uint256 amount, uint64 expiry);
    event OfferCancelled(uint256 indexed id);
    event OfferAccepted(uint256 indexed id, address indexed seller, address indexed collection, uint256 tokenId, uint256 quantity, uint256 price, uint256 fee, uint256 royalty);
    event Credited(address indexed to, uint256 amount);
    event Withdrawn(address indexed from, address indexed to, uint256 amount);
    event GovernanceSet(address governance);
    event FeeSet(uint16 bps, address recipient);
    event ThreatRegistrySet(address registry);

    error NotGovernance();
    error ZeroAddress();
    error FeeTooHigh();
    error NotNFT();
    error BadQuantity();
    error BadPrice();
    error BadExpiry();
    error NotSeller();
    error NotBuyer();
    error NotActive();
    error Expired();
    error WrongValue();
    error SellerLacksToken();
    error NotApproved();
    error CollectionRefused(uint8 reason);
    error TransferFailed();
    error NothingOwed();
    error PayFailed();
    error Reentrancy();
    error GasTooLow();

    modifier onlyGov() {
        if (msg.sender != governance) revert NotGovernance();
        _;
    }

    modifier nonReentrant() {
        if (_lock != 1) revert Reentrancy();
        _lock = 2;
        _;
        _lock = 1;
    }

    constructor(address governance_, address feeRecipient_, uint16 feeBps_, address threatRegistry_) {
        if (governance_ == address(0)) revert ZeroAddress();
        governance = governance_;
        _setFee(feeBps_, feeRecipient_);
        threatRegistry = threatRegistry_;
        emit GovernanceSet(governance_);
        emit ThreatRegistrySet(threatRegistry_);
    }

    // ---- governance ----

    function setGovernance(address g) external onlyGov {
        if (g == address(0)) revert ZeroAddress();
        governance = g;
        emit GovernanceSet(g);
    }

    function setFee(uint16 bps, address recipient) external onlyGov {
        _setFee(bps, recipient);
    }

    /// The ThreatRegistry to ask before listing/buying (zero: no check).
    function setThreatRegistry(address registry) external onlyGov {
        threatRegistry = registry;
        emit ThreatRegistrySet(registry);
    }

    function _setFee(uint16 bps, address recipient) private {
        if (bps > MAX_FEE_BPS) revert FeeTooHigh();
        if (bps != 0 && recipient == address(0)) revert ZeroAddress();
        feeBps = bps;
        feeRecipient = recipient;
        emit FeeSet(bps, recipient);
    }

    // ---- listings ----

    /// Lists `quantity` units (ERC-721: 1) of a token you hold at `unitPrice` wei each,
    /// until `expiry` (unix seconds). Approve this contract first.
    function list(address collection, uint256 tokenId, uint256 quantity, uint256 unitPrice, uint64 expiry) external returns (uint256 id) {
        Kind kind = kindOf(collection);
        if (kind == Kind.None) revert NotNFT();
        if (quantity == 0 || (kind == Kind.ERC721 && quantity != 1)) revert BadQuantity();
        if (unitPrice == 0) revert BadPrice();
        unitPrice * quantity; // reverts (checked math) when the total overflows
        _checkExpiry(expiry);
        _checkThreat(collection);
        if (!_holds(kind, collection, tokenId, msg.sender, quantity)) revert SellerLacksToken();
        if (!_approved(kind, collection, tokenId, msg.sender)) revert NotApproved();
        id = _listings.length;
        _listings.push(Listing(msg.sender, expiry, kind, collection, nonceOf[msg.sender], tokenId, unitPrice, quantity));
        emit Listed(id, msg.sender, collection, tokenId, quantity, unitPrice, expiry);
    }

    function cancel(uint256 id) external {
        Listing storage l = _listing(id);
        if (msg.sender != l.seller) revert NotSeller();
        if (l.quantity == 0) revert NotActive();
        l.quantity = 0;
        emit Cancelled(id);
    }

    /// Cancels every listing you made so far, in one transaction.
    function cancelAll() external {
        uint64 n = ++nonceOf[msg.sender];
        emit CancelledAll(msg.sender, n);
    }

    /// Buys `quantity` units of a listing, paying exactly unitPrice x quantity.
    function buy(uint256 id, uint256 quantity) external payable nonReentrant {
        Listing storage l = _listing(id);
        if (l.quantity == 0 || l.nonce != nonceOf[l.seller]) revert NotActive();
        if (quantity == 0 || quantity > l.quantity) revert BadQuantity();
        if (block.timestamp >= l.expiry) revert Expired();
        uint256 price = l.unitPrice * quantity;
        if (msg.value != price) revert WrongValue();
        (address seller, address collection, uint256 tokenId, Kind kind) = (l.seller, l.collection, l.tokenId, l.kind);
        _checkThreat(collection);
        if (!_holds(kind, collection, tokenId, seller, quantity)) revert SellerLacksToken();
        if (!_approved(kind, collection, tokenId, seller)) revert NotApproved();
        l.quantity -= quantity;
        (uint256 fee, uint256 royalty) = _settle(collection, tokenId, seller, price);
        _deliver(kind, collection, tokenId, seller, msg.sender, quantity);
        emit Sold(id, msg.sender, collection, tokenId, quantity, price, fee, royalty);
    }

    // ---- offers ----

    /// Offers msg.value for `quantity` units (ERC-721: 1) of a token, until `expiry`.
    function makeOffer(address collection, uint256 tokenId, uint256 quantity, uint64 expiry) external payable nonReentrant returns (uint256 id) {
        Kind kind = kindOf(collection);
        if (kind == Kind.None) revert NotNFT();
        if (quantity == 0 || (kind == Kind.ERC721 && quantity != 1)) revert BadQuantity();
        if (msg.value == 0) revert BadPrice();
        _checkExpiry(expiry);
        _checkThreat(collection);
        id = _offers.length;
        _offers.push(Offer(msg.sender, expiry, kind, collection, tokenId, quantity, msg.value));
        emit OfferMade(id, msg.sender, collection, tokenId, quantity, msg.value, expiry);
    }

    /// The buyer takes an offer back (also after it expired); the ZETAPHY is credited to `owed`.
    function cancelOffer(uint256 id) external nonReentrant {
        Offer storage o = _offer(id);
        if (msg.sender != o.buyer) revert NotBuyer();
        uint256 amount = o.amount;
        if (amount == 0) revert NotActive();
        o.amount = 0;
        _credit(o.buyer, amount);
        emit OfferCancelled(id);
    }

    /// A holder of the token accepts an offer: the token goes to the buyer, the
    /// held amount is split like a sale. Approve this contract first.
    function acceptOffer(uint256 id) external nonReentrant {
        Offer storage o = _offer(id);
        uint256 price = o.amount;
        if (price == 0) revert NotActive();
        if (block.timestamp >= o.expiry) revert Expired();
        (address buyer, address collection, uint256 tokenId, uint256 quantity, Kind kind) = (o.buyer, o.collection, o.tokenId, o.quantity, o.kind);
        _checkThreat(collection);
        if (!_holds(kind, collection, tokenId, msg.sender, quantity)) revert SellerLacksToken();
        if (!_approved(kind, collection, tokenId, msg.sender)) revert NotApproved();
        o.amount = 0;
        (uint256 fee, uint256 royalty) = _settle(collection, tokenId, msg.sender, price);
        _deliver(kind, collection, tokenId, msg.sender, buyer, quantity);
        emit OfferAccepted(id, msg.sender, collection, tokenId, quantity, price, fee, royalty);
    }

    // ---- payments (pull) ----

    function withdraw() external {
        withdrawTo(payable(msg.sender));
    }

    /// Sends what you are owed to `to` (e.g. when your own address cannot receive ZETAPHY).
    function withdrawTo(address payable to) public nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        uint256 amount = owed[msg.sender];
        if (amount == 0) revert NothingOwed();
        owed[msg.sender] = 0;
        (bool ok, ) = to.call{value: amount}("");
        if (!ok) revert PayFailed();
        emit Withdrawn(msg.sender, to, amount);
    }

    // ---- views ----

    function listingCount() external view returns (uint256) {
        return _listings.length;
    }

    function offerCount() external view returns (uint256) {
        return _offers.length;
    }

    function getListing(uint256 id) external view returns (Listing memory) {
        return _listing(id);
    }

    function getOffer(uint256 id) external view returns (Offer memory) {
        return _offer(id);
    }

    /// Whether `quantity` units of listing `id` can be bought now, and if not, why
    /// (`quantity` 0 or above what is left: all that is left).
    function listingStatus(uint256 id, uint256 quantity) external view returns (Status) {
        Listing storage l = _listing(id);
        if (l.quantity == 0) return Status.Inactive;
        if (l.nonce != nonceOf[l.seller]) return Status.SellerCancelledAll;
        if (block.timestamp >= l.expiry) return Status.Expired;
        if (_enforced(l.collection)) return Status.Refused;
        if (quantity == 0 || quantity > l.quantity) quantity = l.quantity;
        if (!_holds(l.kind, l.collection, l.tokenId, l.seller, quantity)) return Status.SellerLacksToken;
        if (!_approved(l.kind, l.collection, l.tokenId, l.seller)) return Status.NotApproved;
        return Status.Ok;
    }

    /// How a sale at `price` splits: protocol fee, royalty (capped) and its receiver, the seller's part.
    function quote(address collection, uint256 tokenId, uint256 price) public view returns (uint256 fee, uint256 royalty, address royaltyReceiver, uint256 sellerProceeds) {
        fee = (price * feeBps) / 10_000;
        (royaltyReceiver, royalty) = _royalty(collection, tokenId, price);
        sellerProceeds = price - fee - royalty;
    }

    /// ERC-721, ERC-1155 or neither, by ERC-165 (supportsInterface answered the EIP-165 way).
    function kindOf(address collection) public view returns (Kind) {
        if (collection.code.length == 0) return Kind.None;
        if (!_supports(collection, 0x01ffc9a7) || _supports(collection, 0xffffffff)) return Kind.None;
        if (_supports(collection, 0x80ac58cd)) return Kind.ERC721;
        if (_supports(collection, 0xd9b67a26)) return Kind.ERC1155;
        return Kind.None;
    }

    // ---- internals ----

    function _listing(uint256 id) private view returns (Listing storage) {
        if (id >= _listings.length) revert NotActive();
        return _listings[id];
    }

    function _offer(uint256 id) private view returns (Offer storage) {
        if (id >= _offers.length) revert NotActive();
        return _offers[id];
    }

    function _checkExpiry(uint64 expiry) private view {
        if (expiry <= block.timestamp || expiry > block.timestamp + MAX_DURATION) revert BadExpiry();
    }

    function _enforced(address collection) private view returns (bool) {
        address r = threatRegistry;
        if (r == address(0)) return false;
        (bool on, ) = IThreatRegistryView(r).isContractEnforced(collection);
        return on;
    }

    /// Refuses a collection with an enforced flag. A registry that fails to answer
    /// refuses too (fail closed); governance can set it to zero.
    function _checkThreat(address collection) private view {
        address r = threatRegistry;
        if (r == address(0)) return;
        (bool on, uint8 reason) = IThreatRegistryView(r).isContractEnforced(collection);
        if (on) revert CollectionRefused(reason);
    }

    /// Credits the fee, the royalty and the seller's part; returns (fee, royalty).
    function _settle(address collection, uint256 tokenId, address seller, uint256 price) private returns (uint256 fee, uint256 royalty) {
        address receiver;
        uint256 rest;
        (fee, royalty, receiver, rest) = quote(collection, tokenId, price);
        if (fee != 0) _credit(feeRecipient, fee);
        if (royalty != 0) _credit(receiver, royalty);
        _credit(seller, rest);
    }

    function _credit(address to, uint256 amount) private {
        owed[to] += amount;
        emit Credited(to, amount);
    }

    /// EIP-2981 royaltyInfo with bounded gas (always the full ROYALTY_GAS) and a fixed
    /// 64-byte answer buffer (a collection cannot make us copy a huge return); a
    /// failure or a malformed answer means no royalty; the amount is cut at
    /// MAX_ROYALTY_BPS of the price.
    function _royalty(address collection, uint256 tokenId, uint256 price) private view returns (address receiver, uint256 amount) {
        // EIP-150 passes on at most 63/64 of what is left: without this check a
        // caller (e.g. a seller accepting an offer) could pick a gas limit that
        // starves royaltyInfo, so it "fails" and the royalty is skipped.
        if (gasleft() < ROYALTY_GAS + ROYALTY_GAS / 63 + 5_000) revert GasTooLow();
        bytes memory data = abi.encodeWithSelector(0x2a55205a, tokenId, price);
        bool ok;
        uint256 w0;
        uint256 w1;
        assembly ("memory-safe") {
            let out := mload(0x40)
            ok := staticcall(ROYALTY_GAS, collection, add(data, 32), mload(data), out, 64)
            if lt(returndatasize(), 64) { ok := 0 }
            w0 := mload(out)
            w1 := mload(add(out, 32))
        }
        if (!ok || w0 > type(uint160).max || w0 == 0) return (address(0), 0);
        uint256 cap = (price * MAX_ROYALTY_BPS) / 10_000;
        return (address(uint160(w0)), w1 > cap ? cap : w1);
    }

    /// supportsInterface(id) with PROBE_GAS, true only for a proper 32-byte `true`.
    function _supports(address c, bytes4 iid) private view returns (bool yes) {
        bytes memory data = abi.encodeWithSelector(0x01ffc9a7, iid);
        assembly ("memory-safe") {
            let out := mload(0x40)
            let ok := staticcall(PROBE_GAS, c, add(data, 32), mload(data), out, 32)
            yes := and(and(ok, iszero(lt(returndatasize(), 32))), eq(mload(out), 1))
        }
    }

    function _holds(Kind kind, address c, uint256 tokenId, address who, uint256 quantity) private view returns (bool) {
        if (kind == Kind.ERC721) {
            try IERC721(c).ownerOf(tokenId) returns (address o) { return o == who; } catch { return false; }
        }
        try IERC1155(c).balanceOf(who, tokenId) returns (uint256 b) { return b >= quantity; } catch { return false; }
    }

    function _approved(Kind kind, address c, uint256 tokenId, address who) private view returns (bool) {
        try IERC721(c).isApprovedForAll(who, address(this)) returns (bool all) {
            if (all) return true;
        } catch {
            return false;
        }
        if (kind != Kind.ERC721) return false;
        try IERC721(c).getApproved(tokenId) returns (address a) { return a == address(this); } catch { return false; }
    }

    /// Moves the token with the safe transfer (a contract buyer must accept it), then
    /// checks the buyer really received it (a token that only pretends fails the sale).
    function _deliver(Kind kind, address c, uint256 tokenId, address from, address to, uint256 quantity) private {
        if (kind == Kind.ERC721) {
            IERC721(c).safeTransferFrom(from, to, tokenId);
            if (IERC721(c).ownerOf(tokenId) != to) revert TransferFailed();
        } else {
            uint256 before = IERC1155(c).balanceOf(to, tokenId);
            IERC1155(c).safeTransferFrom(from, to, tokenId, quantity, "");
            if (from != to && IERC1155(c).balanceOf(to, tokenId) != before + quantity) revert TransferFailed();
        }
    }
}
