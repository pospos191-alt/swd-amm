// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

interface IERC20Permit {
    function transferFrom(address from, address to, uint256 value) external returns (bool);
    function transfer(address to, uint256 value) external returns (bool);
    function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s) external;
}

interface INeuroJobs {
    function requestFor(address refundTo, bytes32 chain, string calldata target) external payable returns (uint256);
}

/// @title StableGateway: use the Neuro network paying only in a stablecoin
/// @notice A user who holds a stablecoin but no ZETAPHY signs a job request.
///         Anyone (a "relayer") submits it and pays the gas; in the same
///         transaction the gateway takes the user's stablecoin (the cost of
///         the ZETAPHY fee at a fixed testnet price, plus the relayer's tip)
///         and pays the job fee in ZETAPHY from its own reserve.
///         Testnet: the price is set by the operator, not a market.
contract StableGateway {
    INeuroJobs public immutable jobs;
    address public owner;

    /// stablecoin base units charged per 1 ZETAPHY (1e18 wei); 0 = not accepted
    mapping(address => uint256) public pricePerZeta;
    mapping(address => uint256) public nonces;

    bytes32 public constant REQUEST_TYPEHASH = keccak256(
        "JobRequest(address user,address token,bytes32 chain,string target,uint256 fee,uint256 tip,uint256 maxCost,uint256 nonce,uint256 deadline)");
    uint256 private immutable _chainId;
    bytes32 private immutable _domain;

    struct JobRequest {
        address user;
        address token;
        bytes32 chain;
        string target;
        uint256 fee;      // ZETAPHY (wei) the job pays
        uint256 tip;      // stablecoin units to the relayer
        uint256 maxCost;  // the most stablecoin the user agrees to spend (cost + tip)
        uint256 nonce;
        uint256 deadline;
    }

    struct Permit { uint256 value; uint256 deadline; uint8 v; bytes32 r; bytes32 s; }

    event PriceSet(address indexed token, uint256 pricePerZeta);
    event Paid(uint256 indexed jobId, address indexed user, address indexed token, uint256 cost, uint256 tip, address relayer);
    event OwnerChanged(address owner);

    error NotOwner();
    error Expired();
    error BadNonce();
    error BadSignature();
    error NotAccepted();
    error TooExpensive();
    error ReserveLow();

    constructor(INeuroJobs jobs_) {
        jobs = jobs_;
        owner = msg.sender;
        _chainId = block.chainid;
        _domain = _buildDomain();
    }

    receive() external payable {} // ZETAPHY reserve top-up

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    function setOwner(address o) external onlyOwner {
        owner = o;
        emit OwnerChanged(o);
    }

    function setPrice(address token, uint256 price) external onlyOwner {
        pricePerZeta[token] = price;
        emit PriceSet(token, price);
    }

    /// Stablecoin proceeds go to the treasury the operator names.
    function sweep(address token, address to, uint256 amount) external onlyOwner {
        require(IERC20Permit(token).transfer(to, amount), "transfer failed");
    }

    function withdrawReserve(address payable to, uint256 amount) external onlyOwner {
        (bool ok,) = to.call{value: amount}("");
        require(ok, "transfer failed");
    }

    /// Stablecoin cost of a job fee, rounded up.
    function quote(address token, uint256 fee) public view returns (uint256) {
        uint256 p = pricePerZeta[token];
        if (p == 0) revert NotAccepted();
        return (fee * p + 1e18 - 1) / 1e18;
    }

    function DOMAIN_SEPARATOR() public view returns (bytes32) {
        return block.chainid == _chainId ? _domain : _buildDomain();
    }

    function hashRequest(JobRequest calldata q) public view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR(), keccak256(abi.encode(
            REQUEST_TYPEHASH, q.user, q.token, q.chain, keccak256(bytes(q.target)), q.fee, q.tip, q.maxCost, q.nonce, q.deadline))));
    }

    /// The user already approved this gateway for the stablecoin.
    function request(JobRequest calldata q, bytes calldata sig) external returns (uint256) {
        return _request(q, sig);
    }

    /// Same, with an EIP-2612 permit so the user needs no approve transaction (no gas at all).
    function requestWithPermit(JobRequest calldata q, bytes calldata sig, Permit calldata p) external returns (uint256) {
        // A failed permit is fine if an allowance already exists (e.g. someone front-ran the permit).
        try IERC20Permit(q.token).permit(q.user, address(this), p.value, p.deadline, p.v, p.r, p.s) {} catch {}
        return _request(q, sig);
    }

    function _request(JobRequest calldata q, bytes calldata sig) private returns (uint256 jobId) {
        if (block.timestamp > q.deadline) revert Expired();
        if (q.nonce != nonces[q.user]) revert BadNonce();
        if (_recover(hashRequest(q), sig) != q.user) revert BadSignature();
        nonces[q.user] = q.nonce + 1;

        uint256 cost = quote(q.token, q.fee);
        if (cost + q.tip > q.maxCost) revert TooExpensive();
        if (address(this).balance < q.fee) revert ReserveLow();

        require(IERC20Permit(q.token).transferFrom(q.user, address(this), cost), "payment failed");
        if (q.tip > 0) require(IERC20Permit(q.token).transferFrom(q.user, msg.sender, q.tip), "tip failed");
        jobId = jobs.requestFor{value: q.fee}(q.user, q.chain, q.target);
        emit Paid(jobId, q.user, q.token, cost, q.tip, msg.sender);
    }

    function _recover(bytes32 digest, bytes calldata sig) private pure returns (address) {
        if (sig.length != 65) revert BadSignature();
        bytes32 r = bytes32(sig[0:32]);
        bytes32 s = bytes32(sig[32:64]);
        uint8 v = uint8(sig[64]);
        if (uint256(s) > 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0) revert BadSignature();
        address a = ecrecover(digest, v, r, s);
        if (a == address(0)) revert BadSignature();
        return a;
    }

    function _buildDomain() private view returns (bytes32) {
        return keccak256(abi.encode(
            keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
            keccak256(bytes("ZETAPHY StableGateway")), keccak256(bytes("1")), block.chainid, address(this)));
    }
}
