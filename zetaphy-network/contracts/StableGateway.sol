// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

interface IERC20Permit {
    function transferFrom(address from, address to, uint256 value) external returns (bool);
    function transfer(address to, uint256 value) external returns (bool);
    function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s) external;
}

interface INeuroJobs {
    function requestFor(address refundTo, bytes32 chain, string calldata target) external payable returns (uint256);
    function getJob(uint256 id) external view returns (address requester, uint64 created, uint8 status, bytes32 chain,
        string memory target, uint256 fee, bytes32 result, uint8 commits, uint8 reveals, address[3] memory seat);
    function FAIL_BURN_BPS() external view returns (uint16);
    function credit(address) external view returns (uint256);
    function withdraw() external;
}

/// ZetaphyOracle's consumer surface: a USD price (18 decimals) or a revert.
interface IPriceOracle {
    function price(address asset) external view returns (uint256 value, uint256 updatedAt);
}

/// @title StableGateway: use the Neuro network paying only in a stablecoin
/// @notice A user who holds a stablecoin but no ZETAPHY signs a job request.
///         Anyone (a "relayer") submits it and pays the gas; in the same
///         transaction the gateway takes the user's stablecoin (the cost of
///         the ZETAPHY fee, plus the relayer's tip) and pays the job fee in
///         ZETAPHY from its own reserve.
///         Price: ZetaphyOracle.price(zetaAsset) (ZETAPHY in USD, guarded: TWAP of
///         the DEX, Pyth, deviation, staleness, circuit breaker), and for each
///         accepted stablecoin either its own oracle price or a $1 peg. When the
///         oracle has no valid price the request reverts (PriceUnavailable, with
///         the oracle's reason): never a silently wrong price.
///         TESTNET FALLBACK: a fixed price per token (stablecoin units per 1
///         ZETAPHY), used ONLY while governance switched testnetFixedPrices on
///         (TestnetFixedPricesSet event; priceSource() says so). It is not a
///         market price; it exists for testnet bring-up before the oracle has a
///         TWAP window, and is off by default.
///         Refunds stay in the paying currency (SG-1): the gateway is the job's
///         requester, so when a job fails or expires NeuroJobs credits the
///         ZETAPHY refund to the gateway (back into the reserve), and
///         `refund(jobId)` pays the user the same share of the stablecoin it
///         paid (cost x (1 - NeuroJobs' fail burn)). The reserve is never a
///         stablecoin -> ZETAPHY exchange.
///         Roles: the owner (the ZetaphyTimelock) sets everything and moves funds;
///         guardians (named by the owner) may pause requests at once.
contract StableGateway {
    INeuroJobs public immutable jobs;
    address public owner;
    mapping(address => bool) public guardian;
    bool public paused;

    IPriceOracle public oracle;
    /// The asset id of ZETAPHY in the oracle (the DEX's wrapped ZETAPHY).
    address public zetaAsset;

    struct TokenConfig {
        bool accepted;
        bool oraclePriced;   // false: counted as $1 (a USD stablecoin)
        uint8 decimals;
    }
    mapping(address => TokenConfig) public tokens;

    /// TESTNET ONLY: stablecoin base units per 1 ZETAPHY (1e18 wei), used only while testnetFixedPrices is on.
    bool public testnetFixedPrices;
    mapping(address => uint256) public testnetFixedPrice;
    mapping(address => uint256) public nonces;

    /// What each gateway-paid job cost its user, for the stablecoin refund of a failed job.
    struct PaidJob { address user; address token; uint128 cost; bool refunded; }
    mapping(uint256 => PaidJob) public paidJobs;
    uint8 private constant JOB_FAILED = 3; // NeuroJobs.Status.Failed

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

    event OracleSet(address oracle, address zetaAsset);
    event TokenSet(address indexed token, bool accepted, bool oraclePriced, uint8 decimals);
    event TestnetFixedPricesSet(bool on);
    event TestnetFixedPriceSet(address indexed token, uint256 pricePerZeta);
    event Paid(uint256 indexed jobId, address indexed user, address indexed token, uint256 cost, uint256 tip, address relayer);
    event OwnerChanged(address owner);
    event GuardianSet(address indexed who, bool on);
    event Paused(address indexed by);
    event Unpaused();
    event Refunded(uint256 indexed jobId, address indexed user, address indexed token, uint256 amount);

    error NotOwner();
    error NotGuardian();
    error GatewayPaused();
    error Expired();
    error BadNonce();
    error BadSignature();
    error NotAccepted();
    error TooExpensive();
    error ReserveLow();
    error NoPriceSource();
    error PriceUnavailable(bytes reason);
    error NotRefundable();

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

    function setGuardian(address who, bool on) external onlyOwner {
        guardian[who] = on;
        emit GuardianSet(who, on);
    }

    /// A guardian (or the owner) stops new requests at once; only the owner restarts them.
    function pause() external {
        if (!guardian[msg.sender] && msg.sender != owner) revert NotGuardian();
        paused = true;
        emit Paused(msg.sender);
    }

    function unpause() external onlyOwner {
        paused = false;
        emit Unpaused();
    }

    function setOracle(IPriceOracle o, address zetaAsset_) external onlyOwner {
        oracle = o;
        zetaAsset = zetaAsset_;
        emit OracleSet(address(o), zetaAsset_);
    }

    /// Accept (or stop accepting) a stablecoin; oraclePriced: its own oracle price, else $1.
    function setToken(address token, bool accepted, bool oraclePriced, uint8 decimals) external onlyOwner {
        require(decimals <= 30, "decimals");
        tokens[token] = TokenConfig(accepted, oraclePriced, decimals);
        emit TokenSet(token, accepted, oraclePriced, decimals);
    }

    /// TESTNET ONLY: switch the fixed prices on (they replace the oracle) or off.
    function setTestnetFixedPrices(bool on) external onlyOwner {
        testnetFixedPrices = on;
        emit TestnetFixedPricesSet(on);
    }

    /// TESTNET ONLY: stablecoin units per 1 ZETAPHY, used only while testnetFixedPrices is on.
    function setTestnetFixedPrice(address token, uint256 price) external onlyOwner {
        testnetFixedPrice[token] = price;
        emit TestnetFixedPriceSet(token, price);
    }

    /// Stablecoin proceeds go to the treasury the operator names.
    function sweep(address token, address to, uint256 amount) external onlyOwner {
        require(IERC20Permit(token).transfer(to, amount), "transfer failed");
    }

    function withdrawReserve(address payable to, uint256 amount) external onlyOwner {
        (bool ok,) = to.call{value: amount}("");
        require(ok, "transfer failed");
    }

    /// Where quote() takes its price from.
    function priceSource() external view returns (string memory) {
        if (testnetFixedPrices) return "TESTNET FIXED PRICE (set by governance, not a market price)";
        if (address(oracle) == address(0)) return "none";
        return "ZetaphyOracle";
    }

    /// Stablecoin cost of a job fee, rounded up.
    function quote(address token, uint256 fee) public view returns (uint256) {
        TokenConfig memory t = tokens[token];
        if (!t.accepted) revert NotAccepted();
        if (testnetFixedPrices) {
            uint256 p = testnetFixedPrice[token];
            if (p == 0) revert NotAccepted();
            return (fee * p + 1e18 - 1) / 1e18;
        }
        if (address(oracle) == address(0)) revert NoPriceSource();
        uint256 zetaUsd = _price(zetaAsset);
        uint256 tokenUsd = t.oraclePriced ? _price(token) : 1e18;
        // fee (18 decimals) x ZETAPHY's USD price / the token's USD price, in the token's units, rounded up
        uint256 usd = fee * zetaUsd;                       // USD x 1e36
        uint256 den = tokenUsd * 1e18;
        return (usd * (10 ** uint256(t.decimals)) + den - 1) / den;
    }

    function _price(address asset) private view returns (uint256 v) {
        try oracle.price(asset) returns (uint256 value, uint256) { v = value; } catch (bytes memory reason) { revert PriceUnavailable(reason); }
        if (v == 0) revert PriceUnavailable("");
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
        if (paused) revert GatewayPaused();
        if (block.timestamp > q.deadline) revert Expired();
        if (q.nonce != nonces[q.user]) revert BadNonce();
        if (_recover(hashRequest(q), sig) != q.user) revert BadSignature();
        nonces[q.user] = q.nonce + 1;

        uint256 cost = quote(q.token, q.fee);
        if (cost + q.tip > q.maxCost) revert TooExpensive();
        if (address(this).balance < q.fee) revert ReserveLow();

        require(IERC20Permit(q.token).transferFrom(q.user, address(this), cost), "payment failed");
        if (q.tip > 0) require(IERC20Permit(q.token).transferFrom(q.user, msg.sender, q.tip), "tip failed");
        // the gateway is the requester: a failed job's ZETAPHY refund comes back to the reserve (SG-1)
        jobId = jobs.requestFor{value: q.fee}(address(this), q.chain, q.target);
        paidJobs[jobId] = PaidJob(q.user, q.token, uint128(cost), false);
        emit Paid(jobId, q.user, q.token, cost, q.tip, msg.sender);
    }

    /// A gateway-paid job failed (or expired unanswered): anyone may refund its user in the stablecoin it
    /// paid, the same share NeuroJobs refunds (cost minus the fail burn). The ZETAPHY NeuroJobs credited
    /// to the gateway is pulled back into the reserve.
    function refund(uint256 jobId) external returns (uint256 amount) {
        PaidJob storage p = paidJobs[jobId];
        if (p.user == address(0) || p.refunded) revert NotRefundable();
        (address requester, , uint8 status, , , , , , , ) = jobs.getJob(jobId);
        if (requester != address(this) || status != JOB_FAILED) revert NotRefundable();
        p.refunded = true;
        amount = (uint256(p.cost) * (10_000 - jobs.FAIL_BURN_BPS())) / 10_000;
        if (jobs.credit(address(this)) != 0) jobs.withdraw();
        emit Refunded(jobId, p.user, p.token, amount);
        if (amount > 0) require(IERC20Permit(p.token).transfer(p.user, amount), "refund failed");
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
