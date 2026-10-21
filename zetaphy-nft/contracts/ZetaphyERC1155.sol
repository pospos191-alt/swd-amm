// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {CollectionBase, CollectionConfig} from "./CollectionBase.sol";
import {IERC165, IERC1155, IERC1155MetadataURI, IERC1155Receiver, IERC2981} from "./interfaces/Interfaces.sol";

/// @title ZetaphyERC1155: a minimal ERC-1155 collection (with metadata URI and EIP-2981)
/// @notice The owner creates token ids (1, 2, ...) with `create`, each with its own
///         URI (fixed for good) or the collection's baseURI. More units of an existing
///         id: `mint` (owner) or `publicMintTo` (anyone, mintPrice per unit, while
///         publicMint is on). maxSupply caps the units ever minted of each id.
///
///         `transferCount(holder, id)` counts every time units of `id` LEFT `holder`
///         (a transfer or batch transfer to someone else, or a burn; a market sale
///         too). NFTMarketplace snapshots it when units are listed, so a listing dies
///         for good once the seller's units moved outside the market, even if they
///         come back. Units arriving (transfers in, mints) do not count: they cannot
///         revive anything, and counting them would let anyone kill any seller's
///         listing by sending (or public-minting) one unit to the seller.
///         The count shares the balance's storage word (high 64 bits; the low 192
///         bits are the balance, so at most 2^192 - 1 units of an id are ever minted):
///         no extra storage write, only a few arithmetic operations.
contract ZetaphyERC1155 is CollectionBase, IERC1155MetadataURI {
    /// id => holder => (transferCount << 192) | balance
    mapping(uint256 => mapping(address => uint256)) private _accounts;
    uint256 private constant BALANCE_BITS = 192;
    uint256 private constant BALANCE_MASK = (1 << 192) - 1;
    uint256 private constant ONE_MOVE = 1 << 192;
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
        return _accounts[id][account] & BALANCE_MASK;
    }

    /// How many times units of `id` left `holder` (transfers out and burns).
    function transferCount(address holder, uint256 id) external view returns (uint256) {
        return _accounts[id][holder] >> BALANCE_BITS;
    }

    function balanceOfBatch(address[] calldata accounts, uint256[] calldata ids) external view returns (uint256[] memory out) {
        if (accounts.length != ids.length) revert LengthMismatch();
        out = new uint256[](accounts.length);
        for (uint256 i; i < accounts.length; ++i) out[i] = _accounts[ids[i]][accounts[i]] & BALANCE_MASK;
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
        _take(from, id, amount);
        unchecked { totalSupply[id] -= amount; }
        emit TransferSingle(msg.sender, from, address(0), id, amount);
    }

    function _mint(address to, uint256 id, uint256 amount) private {
        if (!exists(id)) revert NonexistentToken(id);
        if (to == address(0)) revert InvalidReceiver(address(0));
        uint256 minted = totalMinted[id] + amount;
        // Also the hard cap of the packed balance: no balance can ever reach the count bits.
        if ((maxSupply != 0 && minted > maxSupply) || minted > BALANCE_MASK) revert MaxSupplyReached();
        totalMinted[id] = minted;
        if (minted > _largestMinted) _largestMinted = minted;
        totalSupply[id] += amount;
        unchecked { _accounts[id][to] += amount; } // below 2^192: the count bits stay untouched
        emit TransferSingle(msg.sender, address(0), to, id, amount);
        _checkReceiver(address(0), to, id, amount, "");
    }

    function _mintedForCap() internal view override returns (uint256) {
        return _largestMinted;
    }

    function _checkSender(address from) private view {
        if (from != msg.sender && !isApprovedForAll(from, msg.sender)) revert NotAuthorized();
    }

    /// A move to oneself changes no balance (and no count): only the balance is checked.
    function _move(address from, address to, uint256 id, uint256 value) private {
        if (from == to) {
            if ((_accounts[id][from] & BALANCE_MASK) < value) revert InsufficientBalance();
            return;
        }
        _take(from, id, value);
        unchecked { _accounts[id][to] += value; } // every balance stays below 2^192 (the mint cap)
    }

    /// Takes `value` units from `from`; a non-zero amount also counts one move out.
    function _take(address from, uint256 id, uint256 value) private {
        uint256 a = _accounts[id][from];
        if ((a & BALANCE_MASK) < value) revert InsufficientBalance();
        if (value == 0) return;
        unchecked { _accounts[id][from] = a - value + ONE_MOVE; } // the 64-bit count wraps only after 2^64 moves
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
