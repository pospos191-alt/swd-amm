// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {CollectionBase, CollectionConfig} from "./CollectionBase.sol";
import {IERC165, IERC721, IERC721Metadata, IERC721Receiver, IERC2981} from "./interfaces/Interfaces.sol";

/// @title ZetaphyERC721: a minimal ERC-721 collection (with metadata and EIP-2981)
/// @notice Token ids start at 1 and count up. A token's URI is the one given at
///         mint (fixed for good), else baseURI + id. Not enumerable: wallets and
///         the web app find tokens from Transfer events.
contract ZetaphyERC721 is CollectionBase, IERC721 {
    uint256 public constant MAX_MINT_PER_TX = 50;

    mapping(uint256 => address) private _owners;
    mapping(address => uint256) private _balances;
    mapping(uint256 => address) private _tokenApprovals;
    mapping(address => mapping(address => bool)) private _operatorApprovals;
    mapping(uint256 => string) private _tokenURIs;
    uint256 public totalMinted;
    uint256 public totalBurned;

    error NonexistentToken(uint256 tokenId);
    error InvalidOwner();
    error NotAuthorized();
    error IncorrectOwner();
    error InvalidReceiver(address receiver);

    constructor(CollectionConfig memory c, address owner_) CollectionBase(c, owner_) {}

    function supportsInterface(bytes4 id) public pure override returns (bool) {
        return id == type(IERC165).interfaceId || id == type(IERC721).interfaceId
            || id == type(IERC721Metadata).interfaceId || id == type(IERC2981).interfaceId;
    }

    // ---- views ----

    function totalSupply() external view returns (uint256) {
        return totalMinted - totalBurned;
    }

    function balanceOf(address who) external view returns (uint256) {
        if (who == address(0)) revert InvalidOwner();
        return _balances[who];
    }

    function ownerOf(uint256 tokenId) public view returns (address) {
        address o = _owners[tokenId];
        if (o == address(0)) revert NonexistentToken(tokenId);
        return o;
    }

    function tokenURI(uint256 tokenId) external view returns (string memory) {
        ownerOf(tokenId);
        string memory own = _tokenURIs[tokenId];
        if (bytes(own).length != 0) return own;
        if (bytes(_baseURI).length == 0) return "";
        return string.concat(_baseURI, _toString(tokenId));
    }

    function getApproved(uint256 tokenId) external view returns (address) {
        ownerOf(tokenId);
        return _tokenApprovals[tokenId];
    }

    function isApprovedForAll(address who, address operator) public view returns (bool) {
        return _operatorApprovals[who][operator];
    }

    // ---- approvals and transfers ----

    function approve(address to, uint256 tokenId) external {
        address o = ownerOf(tokenId);
        if (msg.sender != o && !isApprovedForAll(o, msg.sender)) revert NotAuthorized();
        _tokenApprovals[tokenId] = to;
        emit Approval(o, to, tokenId);
    }

    function setApprovalForAll(address operator, bool approved) external {
        if (operator == address(0)) revert ZeroAddress();
        _operatorApprovals[msg.sender][operator] = approved;
        emit ApprovalForAll(msg.sender, operator, approved);
    }

    function transferFrom(address from, address to, uint256 tokenId) public {
        if (to == address(0)) revert InvalidReceiver(address(0));
        address o = ownerOf(tokenId);
        if (o != from) revert IncorrectOwner();
        if (msg.sender != o && _tokenApprovals[tokenId] != msg.sender && !isApprovedForAll(o, msg.sender)) revert NotAuthorized();
        delete _tokenApprovals[tokenId];
        unchecked {
            _balances[from] -= 1;
            _balances[to] += 1;
        }
        _owners[tokenId] = to;
        emit Transfer(from, to, tokenId);
    }

    function safeTransferFrom(address from, address to, uint256 tokenId) external virtual {
        safeTransferFrom(from, to, tokenId, "");
    }

    function safeTransferFrom(address from, address to, uint256 tokenId, bytes memory data) public {
        transferFrom(from, to, tokenId);
        _checkReceiver(from, to, tokenId, data);
    }

    // ---- mint and burn ----

    /// Owner mint of one token; `uri` "" uses baseURI. Returns the new id.
    function mint(address to, string calldata uri) external onlyOwner nonReentrant returns (uint256 tokenId) {
        _checkUri(uri);
        tokenId = _reserve(1);
        if (bytes(uri).length != 0) _tokenURIs[tokenId] = uri;
        _mintOne(to, tokenId);
    }

    /// Owner mint of `quantity` tokens (baseURI metadata). Returns the first id.
    function mintMany(address to, uint256 quantity) external onlyOwner nonReentrant returns (uint256 first) {
        first = _mintBatch(to, quantity);
    }

    /// Anyone mints `quantity` tokens at mintPrice each, while publicMint is on.
    function publicMintTo(address to, uint256 quantity) external payable nonReentrant returns (uint256 first) {
        _checkPublicPayment(quantity);
        first = _mintBatch(to, quantity);
    }

    /// The holder (or an approved address) destroys a token. Burned tokens still count toward maxSupply.
    function burn(uint256 tokenId) external {
        address o = ownerOf(tokenId);
        if (msg.sender != o && _tokenApprovals[tokenId] != msg.sender && !isApprovedForAll(o, msg.sender)) revert NotAuthorized();
        delete _tokenApprovals[tokenId];
        delete _owners[tokenId];
        unchecked {
            _balances[o] -= 1;
            totalBurned += 1;
        }
        emit Transfer(o, address(0), tokenId);
    }

    function _mintBatch(address to, uint256 quantity) private returns (uint256 first) {
        if (quantity == 0 || quantity > MAX_MINT_PER_TX) revert BadQuantity();
        first = _reserve(quantity);
        for (uint256 i; i < quantity; ++i) _mintOne(to, first + i);
    }

    /// Takes the next `quantity` ids up front, so a receiver callback that mints
    /// again (where allowed) can never push the total past maxSupply.
    function _reserve(uint256 quantity) private returns (uint256 first) {
        first = totalMinted + 1;
        uint256 next = totalMinted + quantity;
        if (maxSupply != 0 && next > maxSupply) revert MaxSupplyReached();
        totalMinted = next;
    }

    function _mintOne(address to, uint256 tokenId) private {
        if (to == address(0)) revert InvalidReceiver(address(0));
        _owners[tokenId] = to;
        unchecked { _balances[to] += 1; }
        emit Transfer(address(0), to, tokenId);
        _checkReceiver(address(0), to, tokenId, "");
    }

    function _mintedForCap() internal view override returns (uint256) {
        return totalMinted;
    }

    /// ERC-721: a contract recipient must answer onERC721Received with its selector.
    function _checkReceiver(address from, address to, uint256 tokenId, bytes memory data) private {
        if (to.code.length == 0) return;
        try IERC721Receiver(to).onERC721Received(msg.sender, from, tokenId, data) returns (bytes4 ret) {
            if (ret != IERC721Receiver.onERC721Received.selector) revert InvalidReceiver(to);
        } catch (bytes memory reason) {
            if (reason.length == 0) revert InvalidReceiver(to);
            assembly ("memory-safe") {
                revert(add(32, reason), mload(reason))
            }
        }
    }
}
