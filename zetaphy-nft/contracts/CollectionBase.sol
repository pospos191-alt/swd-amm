// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC2981} from "./interfaces/Interfaces.sol";

/// What a creator chooses for a new collection (NFTFactory passes it through).
struct CollectionConfig {
    string name;
    string symbol;
    /// "" = every token gets its own URI at mint. Otherwise ERC-721 tokenURI is
    /// baseURI + decimal id, ERC-1155 uri(id) is baseURI as is (clients replace
    /// "{id}" with the 64-hex-digit id, as ERC-1155 says).
    string baseURI;
    /// Optional collection-level metadata (name, description, image), ipfs:// or https://.
    string contractURI;
    address royaltyReceiver;
    /// EIP-2981 royalty in basis points, at most MAX_ROYALTY_BPS (10%).
    uint96 royaltyBps;
    /// 0 = no cap. ERC-721: tokens ever minted. ERC-1155: units ever minted per token id.
    uint256 maxSupply;
    /// true: anyone may mint at mintPrice (per token / per unit). The owner can always mint.
    bool publicMint;
    uint256 mintPrice;
}

/// @title CollectionBase: what ZetaphyERC721 and ZetaphyERC1155 share
/// @notice Owner, EIP-2981 royalty (capped), max supply (can only go down),
///         mint settings, metadata settings (freezable), and the public-mint
///         proceeds, which only the owner withdraws (pull, never pushed in a mint).
///         State lives in storage, not immutables, so every collection the
///         factory makes has the same runtime code (one code hash to review).
abstract contract CollectionBase is IERC2981 {
    uint96 public constant MAX_ROYALTY_BPS = 1000; // 10%
    uint256 public constant MAX_URI = 8192;        // bytes, per stored URI

    address public owner;
    string internal _name;
    string internal _symbol;
    string public contractURI;
    string internal _baseURI;
    bool public metadataFrozen;
    address public royaltyReceiver;
    uint96 public royaltyBps;
    uint256 public maxSupply;
    bool public publicMint;
    uint256 public mintPrice;
    uint256 private _lock = 1;

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event RoyaltySet(address receiver, uint96 bps);
    event MintSet(bool publicMint, uint256 price);
    event MaxSupplySet(uint256 maxSupply);
    event BaseURISet(string baseURI);
    event ContractURISet(string contractURI);
    event MetadataFrozen();
    event Withdrawn(address indexed to, uint256 amount);

    error NotOwner();
    error ZeroAddress();
    error RoyaltyTooHigh();
    error MaxSupplyReached();
    error BadMaxSupply();
    error PublicMintClosed();
    error WrongPayment();
    error Frozen();
    error UriTooLong();
    error Reentrancy();
    error PayFailed();
    error BadQuantity();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier nonReentrant() {
        if (_lock != 1) revert Reentrancy();
        _lock = 2;
        _;
        _lock = 1;
    }

    constructor(CollectionConfig memory c, address owner_) {
        if (owner_ == address(0)) revert ZeroAddress();
        owner = owner_;
        _name = c.name;
        _symbol = c.symbol;
        _setBaseURI(c.baseURI);
        _checkUri(c.contractURI);
        contractURI = c.contractURI;
        _setRoyalty(c.royaltyReceiver, c.royaltyBps);
        maxSupply = c.maxSupply;
        publicMint = c.publicMint;
        mintPrice = c.mintPrice;
        emit OwnershipTransferred(address(0), owner_);
    }

    // ---- owner ----

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    /// Nobody owns the collection afterwards: no more owner mints or setting changes.
    /// Whatever the contract holds (public-mint proceeds, or ZETAPHY anyone forced in,
    /// e.g. with selfdestruct) is sent to the renouncing owner in the same call, so a
    /// 1-wei donation cannot block renouncing and nothing is left that nobody could take.
    /// Checks-effects-interactions: the owner is cleared before the payment.
    function renounceOwnership() external onlyOwner nonReentrant {
        address previous = owner;
        owner = address(0);
        emit OwnershipTransferred(previous, address(0));
        uint256 amount = address(this).balance;
        if (amount != 0) {
            (bool ok, ) = payable(previous).call{value: amount}("");
            if (!ok) revert PayFailed();
            emit Withdrawn(previous, amount);
        }
    }

    function setRoyalty(address receiver, uint96 bps) external onlyOwner {
        _setRoyalty(receiver, bps);
    }

    function setMint(bool open, uint256 price) external onlyOwner {
        publicMint = open;
        mintPrice = price;
        emit MintSet(open, price);
    }

    /// A cap can be set (from none) or lowered, never raised or removed, and never below what is minted.
    function setMaxSupply(uint256 cap) external onlyOwner {
        if (cap == 0 || (maxSupply != 0 && cap > maxSupply) || cap < _mintedForCap()) revert BadMaxSupply();
        maxSupply = cap;
        emit MaxSupplySet(cap);
    }

    function setBaseURI(string calldata uri) external onlyOwner {
        if (metadataFrozen) revert Frozen();
        _setBaseURI(uri);
    }

    function setContractURI(string calldata uri) external onlyOwner {
        if (metadataFrozen) revert Frozen();
        _checkUri(uri);
        contractURI = uri;
        emit ContractURISet(uri);
    }

    /// Base and contract URIs can no longer change (per-token URIs never can).
    function freezeMetadata() external onlyOwner {
        metadataFrozen = true;
        emit MetadataFrozen();
    }

    /// Public-mint proceeds go to the owner when the owner asks (never pushed during a mint).
    function withdraw() external onlyOwner nonReentrant {
        uint256 amount = address(this).balance;
        (bool ok, ) = payable(msg.sender).call{value: amount}("");
        if (!ok) revert PayFailed();
        emit Withdrawn(msg.sender, amount);
    }

    // ---- EIP-2981 ----

    function royaltyInfo(uint256, uint256 salePrice) external view virtual override returns (address, uint256) {
        return (royaltyReceiver, (salePrice * royaltyBps) / 10_000);
    }

    // ---- internals ----

    function _setRoyalty(address receiver, uint96 bps) internal {
        if (bps > MAX_ROYALTY_BPS) revert RoyaltyTooHigh();
        if (bps != 0 && receiver == address(0)) revert ZeroAddress();
        royaltyReceiver = bps == 0 ? address(0) : receiver;
        royaltyBps = bps;
        emit RoyaltySet(royaltyReceiver, bps);
    }

    function _setBaseURI(string memory uri) internal {
        _checkUri(uri);
        _baseURI = uri;
        emit BaseURISet(uri);
    }

    function _checkUri(string memory uri) internal pure {
        if (bytes(uri).length > MAX_URI) revert UriTooLong();
    }

    /// Public mint: open, and exactly price x quantity paid.
    function _checkPublicPayment(uint256 quantity) internal view {
        if (!publicMint) revert PublicMintClosed();
        if (msg.value != mintPrice * quantity) revert WrongPayment();
    }

    /// The supply the cap is checked against (ERC-721: all minted; ERC-1155: the largest id's minted units).
    function _mintedForCap() internal view virtual returns (uint256);

    function name() external view returns (string memory) {
        return _name;
    }

    function symbol() external view returns (string memory) {
        return _symbol;
    }

    function baseURI() external view returns (string memory) {
        return _baseURI;
    }

    function _toString(uint256 v) internal pure returns (string memory) {
        if (v == 0) return "0";
        uint256 len;
        for (uint256 t = v; t != 0; t /= 10) len++;
        bytes memory b = new bytes(len);
        while (v != 0) {
            b[--len] = bytes1(uint8(48 + (v % 10)));
            v /= 10;
        }
        return string(b);
    }
}
