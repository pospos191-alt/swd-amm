// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {CollectionBase, CollectionConfig} from "./CollectionBase.sol";
import {IERC165, IERC1155, IERC1155MetadataURI, IERC1155Receiver, IERC2981} from "./interfaces/Interfaces.sol";

/// @title ZetaphyERC1155: a minimal ERC-1155 collection (with metadata URI and EIP-2981)
/// @notice The owner creates token ids (1, 2, ...) with `create`, each with its own
///         URI (fixed for good) or the collection's baseURI. More units of an existing
///         id: `mint` (owner) or `publicMintTo` (anyone, mintPrice per unit, while
///         publicMint is on). maxSupply caps the units ever minted of each id.
contract ZetaphyERC1155 is CollectionBase, IERC1155MetadataURI {
    mapping(uint256 => mapping(address => uint256)) private _balances;
    mapping(address => mapping(address => bool)) private _operatorApprovals;
    mapping(uint256 => string) private _tokenURIs;
    /// Units now in existence, per id.
    mapping(uint256 => uint256) public totalSupply;
    /// Units ever minted, per id (what maxSupply caps).
    mapping(uint256 => uint256) public totalMinted;
    /// Ids created so far: ids 1..tokenCount exist.
    uint256 public tokenCount;
    uint256 private _largestMinted;

    error NotAuthorized();
    error InvalidReceiver(address receiver);
    error InsufficientBalance();
    error LengthMismatch();
    error NonexistentToken(uint256 id);

    constructor(CollectionConfig memory c, address owner_) CollectionBase(c, owner_) {}

    function supportsInterface(bytes4 id) public pure override returns (bool) {
        return id == type(IERC165).interfaceId || id == type(IERC1155).interfaceId
            || id == type(IERC1155MetadataURI).interfaceId || id == type(IERC2981).interfaceId;
    }

    // ---- views ----

    function uri(uint256 id) external view returns (string memory) {
        string memory own = _tokenURIs[id];
        return bytes(own).length != 0 ? own : _baseURI;
    }

    function exists(uint256 id) public view returns (bool) {
        return id != 0 && id <= tokenCount;
    }

    function balanceOf(address account, uint256 id) public view returns (uint256) {
        return _balances[id][account];
    }

    function balanceOfBatch(address[] calldata accounts, uint256[] calldata ids) external view returns (uint256[] memory out) {
        if (accounts.length != ids.length) revert LengthMismatch();
        out = new uint256[](accounts.length);
        for (uint256 i; i < accounts.length; ++i) out[i] = _balances[ids[i]][accounts[i]];
    }

    function isApprovedForAll(address account, address operator) public view returns (bool) {
        return _operatorApprovals[account][operator];
    }

    // ---- approvals and transfers ----

    function setApprovalForAll(address operator, bool approved) external {
        if (operator == address(0)) revert ZeroAddress();
        _operatorApprovals[msg.sender][operator] = approved;
        emit ApprovalForAll(msg.sender, operator, approved);
    }

    function safeTransferFrom(address from, address to, uint256 id, uint256 value, bytes calldata data) external {
        _checkSender(from);
        if (to == address(0)) revert InvalidReceiver(address(0));
        _move(from, to, id, value);
        emit TransferSingle(msg.sender, from, to, id, value);
        _checkReceiver(from, to, id, value, data);
    }

    function safeBatchTransferFrom(address from, address to, uint256[] calldata ids, uint256[] calldata values, bytes calldata data) external {
        _checkSender(from);
        if (to == address(0)) revert InvalidReceiver(address(0));
        if (ids.length != values.length) revert LengthMismatch();
        for (uint256 i; i < ids.length; ++i) _move(from, to, ids[i], values[i]);
        emit TransferBatch(msg.sender, from, to, ids, values);
        _checkBatchReceiver(from, to, ids, values, data);
    }

    // ---- create, mint and burn ----

    /// Owner creates the next token id with `amount` units for `to`; `tokenUri` "" uses baseURI.
    function create(address to, uint256 amount, string calldata tokenUri) external onlyOwner nonReentrant returns (uint256 id) {
        _checkUri(tokenUri);
        id = ++tokenCount;
        if (bytes(tokenUri).length != 0) {
            _tokenURIs[id] = tokenUri;
            emit URI(tokenUri, id);
        }
        if (amount != 0) _mint(to, id, amount);
    }

    /// Owner mints more units of an existing id.
    function mint(address to, uint256 id, uint256 amount) external onlyOwner nonReentrant {
        if (amount == 0) revert BadQuantity();
        _mint(to, id, amount);
    }

    /// Anyone mints `amount` units of an existing id at mintPrice each, while publicMint is on.
    function publicMintTo(address to, uint256 id, uint256 amount) external payable nonReentrant {
        if (amount == 0) revert BadQuantity();
        _checkPublicPayment(amount);
        _mint(to, id, amount);
    }

    /// The holder (or an approved operator) destroys units. They still count toward maxSupply.
    function burn(address from, uint256 id, uint256 amount) external {
        _checkSender(from);
        uint256 b = _balances[id][from];
        if (b < amount) revert InsufficientBalance();
        unchecked {
            _balances[id][from] = b - amount;
            totalSupply[id] -= amount;
        }
        emit TransferSingle(msg.sender, from, address(0), id, amount);
    }

    function _mint(address to, uint256 id, uint256 amount) private {
        if (!exists(id)) revert NonexistentToken(id);
        if (to == address(0)) revert InvalidReceiver(address(0));
        uint256 minted = totalMinted[id] + amount;
        if (maxSupply != 0 && minted > maxSupply) revert MaxSupplyReached();
        totalMinted[id] = minted;
        if (minted > _largestMinted) _largestMinted = minted;
        totalSupply[id] += amount;
        _balances[id][to] += amount;
        emit TransferSingle(msg.sender, address(0), to, id, amount);
        _checkReceiver(address(0), to, id, amount, "");
    }

    function _mintedForCap() internal view override returns (uint256) {
        return _largestMinted;
    }

    function _checkSender(address from) private view {
        if (from != msg.sender && !isApprovedForAll(from, msg.sender)) revert NotAuthorized();
    }

    function _move(address from, address to, uint256 id, uint256 value) private {
        uint256 b = _balances[id][from];
        if (b < value) revert InsufficientBalance();
        unchecked { _balances[id][from] = b - value; }
        _balances[id][to] += value;
    }

    /// ERC-1155: a contract recipient must answer with the acceptance magic value.
    function _checkReceiver(address from, address to, uint256 id, uint256 value, bytes memory data) private {
        if (to.code.length == 0) return;
        try IERC1155Receiver(to).onERC1155Received(msg.sender, from, id, value, data) returns (bytes4 ret) {
            if (ret != IERC1155Receiver.onERC1155Received.selector) revert InvalidReceiver(to);
        } catch (bytes memory reason) {
            _bubble(reason, to);
        }
    }

    function _checkBatchReceiver(address from, address to, uint256[] calldata ids, uint256[] calldata values, bytes calldata data) private {
        if (to.code.length == 0) return;
        try IERC1155Receiver(to).onERC1155BatchReceived(msg.sender, from, ids, values, data) returns (bytes4 ret) {
            if (ret != IERC1155Receiver.onERC1155BatchReceived.selector) revert InvalidReceiver(to);
        } catch (bytes memory reason) {
            _bubble(reason, to);
        }
    }

    function _bubble(bytes memory reason, address to) private pure {
        if (reason.length == 0) revert InvalidReceiver(to);
        assembly ("memory-safe") {
            revert(add(32, reason), mload(reason))
        }
    }
}
