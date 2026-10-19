// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title TestStable: testnet-only stand-in for USDC / USDT on ZETAPHY testnet
/// @notice Worthless by design. Anyone can take 1,000 from the faucet once a
///         day. Real USDC arrives only through the bridge in stage 3.
///         ERC-20 + EIP-2612 permit, 6 decimals like USDC/USDT.
contract TestStable {
    string public name;
    string public symbol;
    uint8 public constant decimals = 6;
    uint256 public constant FAUCET_AMOUNT = 1_000 * 10 ** 6;
    uint256 public constant FAUCET_EVERY = 1 days;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    mapping(address => uint256) public nonces;
    mapping(address => uint256) public lastFaucet;

    bytes32 public constant PERMIT_TYPEHASH =
        keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");
    uint256 private immutable _chainId;
    bytes32 private immutable _domain;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(string memory name_, string memory symbol_) {
        name = name_;
        symbol = symbol_;
        _chainId = block.chainid;
        _domain = _buildDomain();
    }

    function faucet() external {
        _drip(msg.sender);
    }

    /// Lets a relay pay the gas for someone who has no ZETAPHY yet.
    function faucetTo(address to) external {
        _drip(to);
    }

    function _drip(address to) private {
        require(to != address(0), "to zero");
        require(block.timestamp >= lastFaucet[to] + FAUCET_EVERY, "faucet: once a day");
        lastFaucet[to] = block.timestamp;
        totalSupply += FAUCET_AMOUNT;
        balanceOf[to] += FAUCET_AMOUNT;
        emit Transfer(address(0), to, FAUCET_AMOUNT);
    }

    function DOMAIN_SEPARATOR() public view returns (bytes32) {
        return block.chainid == _chainId ? _domain : _buildDomain();
    }

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function transfer(address to, uint256 value) external returns (bool) {
        _move(msg.sender, to, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        uint256 a = allowance[from][msg.sender];
        if (a != type(uint256).max) {
            require(a >= value, "allowance");
            allowance[from][msg.sender] = a - value;
        }
        _move(from, to, value);
        return true;
    }

    function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s) external {
        require(block.timestamp <= deadline, "permit: expired");
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR(),
            keccak256(abi.encode(PERMIT_TYPEHASH, owner, spender, value, nonces[owner]++, deadline))));
        require(uint256(s) <= 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0, "permit: bad s");
        address signer = ecrecover(digest, v, r, s);
        require(signer != address(0) && signer == owner, "permit: bad signature");
        allowance[owner][spender] = value;
        emit Approval(owner, spender, value);
    }

    function _move(address from, address to, uint256 value) private {
        require(to != address(0), "to zero");
        uint256 b = balanceOf[from];
        require(b >= value, "balance");
        unchecked { balanceOf[from] = b - value; }
        balanceOf[to] += value;
        emit Transfer(from, to, value);
    }

    function _buildDomain() private view returns (bytes32) {
        return keccak256(abi.encode(
            keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
            keccak256(bytes(name)), keccak256(bytes("1")), block.chainid, address(this)));
    }
}
