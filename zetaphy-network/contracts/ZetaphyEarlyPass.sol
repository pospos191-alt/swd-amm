// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

interface IZearly {
    function balanceOf(address) external view returns (uint256);
    function transferFrom(address from, address to, uint256 value) external returns (bool);
}

interface IERC721Receiver {
    function onERC721Received(address operator, address from, uint256 tokenId, bytes calldata data) external returns (bytes4);
}

/// @title ZETAPHY Early Pass: an NFT paid for in ZETAPHY Early (ZEARLY)
/// @notice Anyone may mint one pass per wallet by paying `price` ZEARLY, which is burned (sent to 0x…dEaD).
///         Before `earlyUntil`, only wallets holding at least `minHold` ZEARLY may mint: the early supporters' perk.
///         At most `maxSupply` passes. The picture and the metadata are drawn on chain (no server, no IPFS).
///         No owner, no admin: the rules above are fixed at deploy. Testnet; no value (zetaphy-chain/rewards/EARLY.md).
contract ZetaphyEarlyPass {
    string public constant name = "ZETAPHY Early Pass";
    string public constant symbol = "ZEPASS";
    address public constant BURN = 0x000000000000000000000000000000000000dEaD;

    IZearly public immutable zearly;
    uint256 public immutable price;
    uint256 public immutable maxSupply;
    uint64 public immutable earlyUntil;
    uint256 public immutable minHold;

    uint256 public totalSupply;
    mapping(uint256 => address) private _owner;
    mapping(address => uint256) public balanceOf;
    mapping(uint256 => address) public getApproved;
    mapping(address => mapping(address => bool)) public isApprovedForAll;
    mapping(address => bool) public minted; // one pass per wallet, ever

    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);
    event Approval(address indexed owner, address indexed approved, uint256 indexed tokenId);
    event ApprovalForAll(address indexed owner, address indexed operator, bool approved);

    error SoldOut();
    error AlreadyMinted();
    error EarlyHoldersOnly();
    error PaymentFailed();
    error NotToken();
    error NotAllowed();
    error ZeroAddress();
    error NotReceiver();

    constructor(address zearly_, uint256 price_, uint256 maxSupply_, uint64 earlyUntil_, uint256 minHold_) {
        if (zearly_ == address(0)) revert ZeroAddress();
        zearly = IZearly(zearly_);
        price = price_;
        maxSupply = maxSupply_;
        earlyUntil = earlyUntil_;
        minHold = minHold_;
    }

    /// @notice Mint your pass: pay `price` ZEARLY (approve this contract first); it is burned.
    function mint() external returns (uint256 id) {
        if (totalSupply >= maxSupply) revert SoldOut();
        if (minted[msg.sender]) revert AlreadyMinted();
        if (block.timestamp < earlyUntil && zearly.balanceOf(msg.sender) < minHold) revert EarlyHoldersOnly();
        minted[msg.sender] = true;
        id = ++totalSupply;
        if (price != 0 && !zearly.transferFrom(msg.sender, BURN, price)) revert PaymentFailed();
        _owner[id] = msg.sender;
        balanceOf[msg.sender] += 1;
        emit Transfer(address(0), msg.sender, id);
    }

    // ------------------------------------------------------------------ ERC-721
    function ownerOf(uint256 id) public view returns (address o) {
        o = _owner[id];
        if (o == address(0)) revert NotToken();
    }

    function approve(address to, uint256 id) external {
        address o = ownerOf(id);
        if (msg.sender != o && !isApprovedForAll[o][msg.sender]) revert NotAllowed();
        getApproved[id] = to;
        emit Approval(o, to, id);
    }

    function setApprovalForAll(address operator, bool approved) external {
        isApprovedForAll[msg.sender][operator] = approved;
        emit ApprovalForAll(msg.sender, operator, approved);
    }

    function transferFrom(address from, address to, uint256 id) public {
        if (to == address(0)) revert ZeroAddress();
        address o = ownerOf(id);
        if (o != from) revert NotAllowed();
        if (msg.sender != o && getApproved[id] != msg.sender && !isApprovedForAll[o][msg.sender]) revert NotAllowed();
        delete getApproved[id];
        unchecked { balanceOf[from] -= 1; balanceOf[to] += 1; }
        _owner[id] = to;
        emit Transfer(from, to, id);
    }

    function safeTransferFrom(address from, address to, uint256 id) external {
        safeTransferFrom(from, to, id, "");
    }

    function safeTransferFrom(address from, address to, uint256 id, bytes memory data) public {
        transferFrom(from, to, id);
        if (to.code.length != 0 && IERC721Receiver(to).onERC721Received(msg.sender, from, id, data) != IERC721Receiver.onERC721Received.selector) {
            revert NotReceiver();
        }
    }

    function supportsInterface(bytes4 i) external pure returns (bool) {
        return i == 0x01ffc9a7 || i == 0x80ac58cd || i == 0x5b5e139f; // ERC-165, ERC-721, ERC-721 metadata
    }

    // ------------------------------------------------------------------ metadata, drawn on chain
    function tokenURI(uint256 id) external view returns (string memory) {
        ownerOf(id);
        string memory n = _str(id);
        string memory svg = string.concat(
            "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 512 512'>",
            "<defs><radialGradient id='b' cx='.35' cy='.3' r='.85'><stop offset='0' stop-color='#1B2540'/><stop offset='1' stop-color='#070B16'/></radialGradient>",
            "<linearGradient id='g' x1='1' y1='0' x2='0' y2='1'><stop offset='0' stop-color='#FCD772'/><stop offset='1' stop-color='#E0981F'/></linearGradient></defs>",
            "<rect width='512' height='512' rx='48' fill='url(#b)'/>",
            "<path d='M168 140 H344 M168 316 H344' stroke='#fff' stroke-width='56' stroke-linecap='round'/>",
            "<path d='M344 140 L168 316' stroke='url(#g)' stroke-width='56' stroke-linecap='round'/>",
            "<circle cx='392' cy='92' r='26' fill='url(#g)'/>",
            "<text x='256' y='418' fill='#FCD772' font-family='sans-serif' font-size='34' font-weight='700' text-anchor='middle' letter-spacing='4'>EARLY PASS</text>",
            "<text x='256' y='464' fill='#fff' font-family='monospace' font-size='28' text-anchor='middle'>#", n, "</text></svg>"
        );
        string memory json = string.concat(
            '{"name":"ZETAPHY Early Pass #', n,
            '","description":"Minted with ZETAPHY Early (ZEARLY) on the ZETAPHY testnet. One per wallet. No value.",',
            '"image":"data:image/svg+xml;base64,', _b64(bytes(svg)),
            '","attributes":[{"trait_type":"Number","value":', n, '}]}'
        );
        return string.concat("data:application/json;base64,", _b64(bytes(json)));
    }

    function _str(uint256 v) private pure returns (string memory) {
        if (v == 0) return "0";
        uint256 len;
        for (uint256 t = v; t != 0; t /= 10) len++;
        bytes memory b = new bytes(len);
        for (; v != 0; v /= 10) b[--len] = bytes1(uint8(48 + v % 10));
        return string(b);
    }

    function _b64(bytes memory data) private pure returns (string memory) {
        bytes memory T = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        uint256 n = data.length;
        if (n == 0) return "";
        bytes memory out = new bytes(4 * ((n + 2) / 3));
        uint256 j;
        for (uint256 i; i < n; i += 3) {
            uint256 a = uint8(data[i]);
            uint256 b = i + 1 < n ? uint8(data[i + 1]) : 0;
            uint256 c = i + 2 < n ? uint8(data[i + 2]) : 0;
            uint256 x = (a << 16) | (b << 8) | c;
            out[j++] = T[(x >> 18) & 63];
            out[j++] = T[(x >> 12) & 63];
            out[j++] = i + 1 < n ? T[(x >> 6) & 63] : bytes1("=");
            out[j++] = i + 2 < n ? T[x & 63] : bytes1("=");
        }
        return string(out);
    }
}
