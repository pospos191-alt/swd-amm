// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {CollectionConfig} from "./CollectionBase.sol";
import {ZetaphyERC721} from "./ZetaphyERC721.sol";
import {ZetaphyERC1155} from "./ZetaphyERC1155.sol";

/// Deploys one kind of collection for the factory that made it (keeps each
/// contract well under the 24 KB code limit).
contract ERC721Deployer {
    address public immutable factory = msg.sender;

    function deploy(CollectionConfig calldata c, address owner_) external returns (address) {
        require(msg.sender == factory, "factory only");
        return address(new ZetaphyERC721(c, owner_));
    }
}

contract ERC1155Deployer {
    address public immutable factory = msg.sender;

    function deploy(CollectionConfig calldata c, address owner_) external returns (address) {
        require(msg.sender == factory, "factory only");
        return address(new ZetaphyERC1155(c, owner_));
    }
}

/// @title NFTFactory: anyone creates an ERC-721 or ERC-1155 collection
/// @notice The caller owns the new collection. `isCollection` answers whether an
///         address was made here (the web app shows "made by the ZETAPHY factory"
///         for those, and "external contract" for any other). The factory has no
///         owner, no fee and no control over the collections it made.
contract NFTFactory {
    enum Kind { None, ERC721, ERC1155 }

    ERC721Deployer public immutable erc721Deployer = new ERC721Deployer();
    ERC1155Deployer public immutable erc1155Deployer = new ERC1155Deployer();
    mapping(address => Kind) public kindOf;
    address[] private _collections;

    event CollectionCreated(address indexed collection, address indexed creator, Kind kind, string name, string symbol);

    function createERC721(CollectionConfig calldata c) external returns (address collection) {
        collection = erc721Deployer.deploy(c, msg.sender);
        _record(collection, Kind.ERC721, c);
    }

    function createERC1155(CollectionConfig calldata c) external returns (address collection) {
        collection = erc1155Deployer.deploy(c, msg.sender);
        _record(collection, Kind.ERC1155, c);
    }

    function isCollection(address a) external view returns (bool) {
        return kindOf[a] != Kind.None;
    }

    function collectionCount() external view returns (uint256) {
        return _collections.length;
    }

    /// Collections [start, start + count), cut at the end of the list.
    function collections(uint256 start, uint256 count) external view returns (address[] memory out) {
        uint256 n = _collections.length;
        if (start >= n) return out;
        if (count > n - start) count = n - start;
        out = new address[](count);
        for (uint256 i; i < count; ++i) out[i] = _collections[start + i];
    }

    function _record(address collection, Kind kind, CollectionConfig calldata c) private {
        kindOf[collection] = kind;
        _collections.push(collection);
        emit CollectionCreated(collection, msg.sender, kind, c.name, c.symbol);
    }
}
