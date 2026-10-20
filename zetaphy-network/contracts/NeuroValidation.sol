// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

interface IValidationRunners {
    function workers(address) external view returns (uint128 bond, uint64 unbondAt, bool active, uint32 agreed, uint32 rejected);
}

interface IIdentityRegistry {
    function ownerOf(uint256 tokenId) external view returns (address);
    function getApproved(uint256 tokenId) external view returns (address);
    function isApprovedForAll(address owner, address operator) external view returns (bool);
    function webEndpoint(uint256 agentId) external view returns (string memory);
}

/// @title NeuroValidation: ERC-8004 Validation Registry answered by Neuro runners
/// @notice The ERC-8004 Validation Registry interface. Validators here are the
///         bonded NeuroJobs runners with a track record (active, at least
///         `minAgreed` accepted verdicts, no more rejected than accepted):
///         stake-secured re-execution, which ERC-8004 calls "crypto-economic"
///         trust. A runner posts Neuro's verdict on an agent (a contract's
///         identity) as a validation response: the verdict hash and a 0-100
///         score.
///
///         - `validationRequest` / `validationResponse` follow the spec: the
///           agent's owner or operator asks a named validator, and only that
///           validator answers (and it must be a runner when it answers).
///         - `postVerdict` lets a runner publish a verdict on any agent without
///           a request, because an unclaimed contract identity has no owner to
///           ask, and an owner must not be able to keep Neuro's verdicts off
///           its identity. It emits the same two spec events.
///         - Each runner has ONE verdict slot per agent, at
///           `verdictRequestHash(agentId, runner)`. A newer verdict replaces the
///           older one. Verdict slots live in their own namespace: their hash
///           starts with VERDICT_TAG, and `validationRequest` refuses any hash
///           that does, so nobody can pre-create a runner's slot under another
///           agent and steal its verdicts.
///         - `getSummary` counts each validator once per agent: its latest
///           answer there (a verdict or a spec response). One runner cannot
///           outweigh the others by answering many times.
///         - A spec `requestHash` is first come, first served (the spec reads
///           by the bare hash, so it cannot be bound to the requester). Make it
///           commit to the request (e.g. keccak of agentId, validator and the
///           request file); if someone takes it first, `validationRequest`
///           reverts `Exists` and nothing of yours is written, so pick a new
///           hash. Validators should check `getValidationStatus(h).agentId`
///           before answering.
contract NeuroValidation {
    struct ValidationStatus {
        address validatorAddress;
        uint256 agentId;
        uint8 response;      // 0..100
        bytes32 responseHash;
        string tag;
        uint256 lastUpdate;
        bool hasResponse;
    }

    address public immutable identityRegistry;
    IValidationRunners public immutable runners;
    uint32 public immutable minAgreed;
    uint256 public constant MAX_TAG = 64;
    /// First 4 bytes of every postVerdict slot hash ("NVD1"); spec requests may not use them.
    bytes4 public constant VERDICT_TAG = 0x4e564431;
    bytes32 private constant TAG_MASK = 0xffffffff00000000000000000000000000000000000000000000000000000000;

    mapping(bytes32 => ValidationStatus) private _validations;
    mapping(uint256 => bytes32[]) private _agentValidations;
    mapping(address => bytes32[]) private _validatorRequests;
    /// agentId => validator => requestHash of its latest answer on that agent
    mapping(uint256 => mapping(address => bytes32)) private _latest;

    event ValidationRequest(address indexed validatorAddress, uint256 indexed agentId, string requestURI, bytes32 indexed requestHash);
    event ValidationResponse(address indexed validatorAddress, uint256 indexed agentId, bytes32 indexed requestHash,
        uint8 response, string responseURI, bytes32 responseHash, string tag);

    error BadValue();
    error NotAuthorized();
    error Exists();
    error Unknown();
    error NotValidator();
    error NotRunner();
    error ReservedHash();

    constructor(address identityRegistry_, IValidationRunners runners_, uint32 minAgreed_) {
        if (identityRegistry_ == address(0) || address(runners_) == address(0) || minAgreed_ == 0) revert BadValue();
        identityRegistry = identityRegistry_;
        runners = runners_;
        minAgreed = minAgreed_;
    }

    function getIdentityRegistry() external view returns (address) {
        return identityRegistry;
    }

    /// Is `who` a bonded runner with a track record right now?
    function isRunner(address who) public view returns (bool) {
        (, , bool active, uint32 agreed, uint32 rejected) = runners.workers(who);
        return active && agreed >= minAgreed && rejected <= agreed;
    }

    // ---------------------------------------------------------- ERC-8004

    function validationRequest(address validatorAddress, uint256 agentId, string calldata requestURI, bytes32 requestHash) external {
        if (validatorAddress == address(0) || requestHash == bytes32(0)) revert BadValue();
        if (isVerdictHash(requestHash)) revert ReservedHash();
        if (_validations[requestHash].validatorAddress != address(0)) revert Exists();
        IIdentityRegistry reg = IIdentityRegistry(identityRegistry);
        address owner = reg.ownerOf(agentId);
        if (msg.sender != owner && !reg.isApprovedForAll(owner, msg.sender) && reg.getApproved(agentId) != msg.sender) revert NotAuthorized();
        _open(validatorAddress, agentId, requestURI, requestHash);
    }

    function validationResponse(bytes32 requestHash, uint8 response, string calldata responseURI, bytes32 responseHash, string calldata tag) external {
        ValidationStatus storage s = _validations[requestHash];
        if (s.validatorAddress == address(0)) revert Unknown();
        if (msg.sender != s.validatorAddress) revert NotValidator();
        if (!isRunner(msg.sender)) revert NotRunner();
        _answer(s, requestHash, response, responseURI, responseHash, tag);
    }

    // ------------------------------------------------------------- Neuro

    /// A runner publishes Neuro's verdict on `agentId`: `verdictHash` is the
    /// verdict (as in NeuroJobs, stored as the responseHash), `score` 0-100
    /// (100 = no problems found). A runner has one verdict slot per agent: a
    /// new post replaces its previous verdict there.
    function postVerdict(uint256 agentId, bytes32 verdictHash, uint8 score, string calldata responseURI, string calldata tag)
        external returns (bytes32 requestHash)
    {
        if (!isRunner(msg.sender)) revert NotRunner();
        if (verdictHash == bytes32(0)) revert BadValue();
        IIdentityRegistry(identityRegistry).ownerOf(agentId); // reverts for an unknown agent
        requestHash = verdictRequestHash(agentId, msg.sender);
        ValidationStatus storage s = _validations[requestHash];
        if (s.validatorAddress == address(0)) {
            string memory uri;
            try IIdentityRegistry(identityRegistry).webEndpoint(agentId) returns (string memory u) { uri = u; } catch {}
            _open(msg.sender, agentId, uri, requestHash);
        } else if (s.agentId != agentId || s.validatorAddress != msg.sender) {
            revert NotAuthorized(); // unreachable while only postVerdict writes tagged slots; kept as a guard
        }
        _answer(s, requestHash, score, responseURI, verdictHash, tag);
    }

    /// The one verdict slot of `runner` on `agentId`. Its first 4 bytes are VERDICT_TAG.
    function verdictRequestHash(uint256 agentId, address runner) public view returns (bytes32) {
        bytes32 h = keccak256(abi.encode("neuro.verdict.v1", address(this), agentId, runner));
        return (h & ~TAG_MASK) | bytes32(VERDICT_TAG);
    }

    /// Is `requestHash` in the postVerdict namespace (closed to validationRequest)?
    function isVerdictHash(bytes32 requestHash) public pure returns (bool) {
        return bytes4(requestHash) == VERDICT_TAG;
    }

    // ------------------------------------------------------------- reads

    function getValidationStatus(bytes32 requestHash) external view returns (
        address validatorAddress, uint256 agentId, uint8 response, bytes32 responseHash, string memory tag, uint256 lastUpdate
    ) {
        ValidationStatus storage s = _validations[requestHash];
        if (s.validatorAddress == address(0)) revert Unknown();
        return (s.validatorAddress, s.agentId, s.response, s.responseHash, s.tag, s.lastUpdate);
    }

    /// Average response of answered validations, optionally only from
    /// `validatorAddresses` and with `tag`. Each validator counts once per
    /// agent: only its latest answer on that agent is read.
    function getSummary(uint256 agentId, address[] calldata validatorAddresses, string calldata tag)
        external view returns (uint64 count, uint8 averageResponse)
    {
        bytes32[] storage list = _agentValidations[agentId];
        bytes32 tagHash = keccak256(bytes(tag));
        uint256 total;
        for (uint256 i; i < list.length; i++) {
            ValidationStatus storage s = _validations[list[i]];
            if (!s.hasResponse) continue;
            if (_latest[agentId][s.validatorAddress] != list[i]) continue; // superseded by a newer answer
            if (bytes(tag).length > 0 && keccak256(bytes(s.tag)) != tagHash) continue;
            if (validatorAddresses.length > 0) {
                bool found;
                for (uint256 j; j < validatorAddresses.length; j++) if (validatorAddresses[j] == s.validatorAddress) { found = true; break; }
                if (!found) continue;
            }
            total += s.response;
            count++;
        }
        averageResponse = count > 0 ? uint8(total / count) : 0;
    }

    function getAgentValidations(uint256 agentId) external view returns (bytes32[] memory) {
        return _agentValidations[agentId];
    }

    function getValidatorRequests(address validatorAddress) external view returns (bytes32[] memory) {
        return _validatorRequests[validatorAddress];
    }

    // ------------------------------------------------------------ internal

    function _open(address validatorAddress, uint256 agentId, string memory requestURI, bytes32 requestHash) internal {
        ValidationStatus storage s = _validations[requestHash];
        s.validatorAddress = validatorAddress;
        s.agentId = agentId;
        s.lastUpdate = block.timestamp;
        _agentValidations[agentId].push(requestHash);
        _validatorRequests[validatorAddress].push(requestHash);
        emit ValidationRequest(validatorAddress, agentId, requestURI, requestHash);
    }

    function _answer(ValidationStatus storage s, bytes32 requestHash, uint8 response, string calldata responseURI, bytes32 responseHash, string calldata tag) internal {
        if (response > 100 || bytes(tag).length > MAX_TAG) revert BadValue();
        s.response = response;
        s.responseHash = responseHash;
        s.tag = tag;
        s.lastUpdate = block.timestamp;
        s.hasResponse = true;
        _latest[s.agentId][s.validatorAddress] = requestHash;
        emit ValidationResponse(s.validatorAddress, s.agentId, requestHash, response, responseURI, responseHash, tag);
    }
}
