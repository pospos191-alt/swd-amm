// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

interface IERC721Receiver {
    function onERC721Received(address operator, address from, uint256 tokenId, bytes calldata data) external returns (bytes4);
}

/// @title NeuroIdentity: one contract = one on-chain identity (ERC-8004 Identity Registry)
/// @notice An ERC-8004 ("Trustless Agents") Identity Registry: an ERC-721 whose
///         tokenId is the agentId and whose tokenURI (agentURI) resolves to the
///         agent registration file. On top of the plain ERC-8004 `register()`
///         calls, it gives every analysed contract, on any chain Neuro reads,
///         exactly one agent: "the Neuro of that contract".
///
///         Rules for a contract's identity (registerTarget / claim):
///         - Anyone may register a target. The identity is keyed by the target
///           (CAIP-10 style `namespace:reference:account`), so each target has
///           at most one, and the registry records who registered it.
///         - A new identity is held by this registry itself, so nobody (not the
///           registrant, not the admin) can edit, move or speak for it. Its
///           agentURI is built on-chain and points only at Neuro's report for
///           that target. A squatter therefore gains nothing: registering just
///           makes the Neuro report discoverable.
///         - The target's real owner can take control with proof. For a
///           contract on this chain: a call from the contract itself, or from
///           the address its `owner()` returns. Control follows the contract:
///           whoever can prove it now can claim again, even after a transfer.
///           Targets on other chains cannot be claimed here (no proof yet).
///         - A claimed identity behaves as a normal ERC-8004 agent (custom
///           agentURI, metadata, agentWallet, transfer). `neuroURI()` and
///           `getTarget()` still show what the identity is about, whatever its
///           owner writes in the agentURI.
contract NeuroIdentity {
    // ---------------------------------------------------------------- types

    struct MetadataEntry {
        string metadataKey;
        bytes metadataValue;
    }

    struct Target {
        string chain;        // Neuro chain key, e.g. "bsc"
        string account;      // canonical address / token id on that chain
        address registeredBy;
        uint64 registeredAt;
    }

    struct Chain {
        string caip2;        // e.g. "eip155:56"
        uint8 rule;          // RULE_*: how strictly the account is checked
        bool exists;
    }

    uint8 public constant RULE_TEXT = 0;      // [A-Za-z0-9._:-] and %XX (uppercase hex)
    uint8 public constant RULE_LOWER = 1;     // [a-z0-9._:-] only (bech32, NEAR, Starknet hex)
    uint8 public constant RULE_EVM = 2;       // 0x + 40 lowercase hex

    string public constant name = "Neuro Agent Identity";
    string public constant symbol = "NEURO";
    string public constant REGISTRATION_TYPE = "https://eips.ethereum.org/EIPS/eip-8004#registration-v1";

    // ------------------------------------------------------------- storage

    mapping(uint256 => address) private _owners;
    mapping(address => uint256) private _balances;
    mapping(uint256 => address) private _tokenApprovals;
    mapping(address => mapping(address => bool)) private _operatorApprovals;

    /// Last agentId handed out. Ids start at 1, so 0 means "none" (and "broadcast" in Neuro messages).
    uint256 public lastId;
    mapping(uint256 => string) private _uris;
    mapping(uint256 => mapping(string => bytes)) private _metadata;
    mapping(uint256 => Target) private _targets;
    /// keccak256(bytes(caip10)) => agentId
    mapping(bytes32 => uint256) public agentOfTarget;

    mapping(string => Chain) private _chains;
    string[] public chainKeys;
    bytes32 public immutable localCaip2Hash; // keccak256("eip155:<this chain id>")

    address public admin;
    string public webBase;   // Neuro web, e.g. "https://neuro.example/web/"
    string public imageURI;

    // -------------------------------------------------------------- events

    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);
    event Approval(address indexed owner, address indexed approved, uint256 indexed tokenId);
    event ApprovalForAll(address indexed owner, address indexed operator, bool approved);
    // ERC-4906
    event MetadataUpdate(uint256 _tokenId);
    event BatchMetadataUpdate(uint256 _fromTokenId, uint256 _toTokenId);
    // ERC-8004
    event Registered(uint256 indexed agentId, string agentURI, address indexed owner);
    event MetadataSet(uint256 indexed agentId, string indexed indexedMetadataKey, string metadataKey, bytes metadataValue);
    event URIUpdated(uint256 indexed agentId, string newURI, address indexed updatedBy);
    // Neuro
    event TargetRegistered(uint256 indexed agentId, bytes32 indexed targetHash, string target, address indexed registeredBy);
    event Claimed(uint256 indexed agentId, address indexed by, address indexed previousOwner);
    event ChainAdded(string key, string caip2, uint8 rule);
    event WebBaseSet(string webBase, string imageURI);
    event AdminSet(address admin);

    error NotAuthorized();
    error Nonexistent();
    error ReservedKey();
    error BadWallet();
    error Expired();
    error DeadlineTooFar();
    error InvalidSignature();
    error UnknownChain();
    error BadAccount();
    error BadValue();
    error ChainExists();
    error AlreadyRegistered(uint256 agentId);
    error NotTarget();
    error NotLocal();
    error NotTargetOwner();
    error AlreadyHolder();
    error UnsafeRecipient();

    bytes32 private constant AGENT_WALLET_SET_TYPEHASH =
        keccak256("AgentWalletSet(uint256 agentId,address newWallet,address owner,uint256 deadline)");
    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant NAME_HASH = keccak256("ERC8004IdentityRegistry");
    bytes32 private constant VERSION_HASH = keccak256("1");
    uint256 private constant MAX_DEADLINE_DELAY = 5 minutes;
    bytes32 private constant KEY_WALLET = keccak256("agentWallet");
    bytes32 private constant KEY_TARGET = keccak256("neuro.target");
    bytes32 private constant KEY_REGISTERED_BY = keccak256("neuro.registeredBy");

    constructor(string memory webBase_, string memory image_, string[] memory keys, string[] memory caip2s, uint8[] memory rules) {
        if (keys.length != caip2s.length || keys.length != rules.length) revert BadValue();
        admin = msg.sender;
        localCaip2Hash = keccak256(bytes(string.concat("eip155:", _toString(block.chainid))));
        _setWeb(webBase_, image_);
        for (uint256 i; i < keys.length; i++) _addChain(keys[i], caip2s[i], rules[i]);
    }

    // ============================================================ ERC-165

    function supportsInterface(bytes4 id) external pure returns (bool) {
        return id == 0x01ffc9a7    // ERC-165
            || id == 0x80ac58cd    // ERC-721
            || id == 0x5b5e139f    // ERC-721 Metadata
            || id == 0x49064906;   // ERC-4906 (metadata update events)
    }

    // ============================================================ ERC-721

    function balanceOf(address owner) external view returns (uint256) {
        if (owner == address(0)) revert BadValue();
        return _balances[owner];
    }

    function ownerOf(uint256 tokenId) public view returns (address o) {
        o = _owners[tokenId];
        if (o == address(0)) revert Nonexistent();
    }

    function approve(address to, uint256 tokenId) external {
        address o = ownerOf(tokenId);
        if (msg.sender != o && !_operatorApprovals[o][msg.sender]) revert NotAuthorized();
        _tokenApprovals[tokenId] = to;
        emit Approval(o, to, tokenId);
    }

    function getApproved(uint256 tokenId) public view returns (address) {
        ownerOf(tokenId);
        return _tokenApprovals[tokenId];
    }

    function setApprovalForAll(address operator, bool approved) external {
        if (operator == address(0)) revert BadValue();
        _operatorApprovals[msg.sender][operator] = approved;
        emit ApprovalForAll(msg.sender, operator, approved);
    }

    function isApprovedForAll(address owner, address operator) public view returns (bool) {
        return _operatorApprovals[owner][operator];
    }

    function transferFrom(address from, address to, uint256 tokenId) public {
        address o = ownerOf(tokenId);
        if (o != from) revert NotAuthorized();
        if (!_isAuthorized(o, msg.sender, tokenId)) revert NotAuthorized();
        if (to == address(0)) revert BadValue();
        _transfer(from, to, tokenId);
    }

    function safeTransferFrom(address from, address to, uint256 tokenId) external {
        safeTransferFrom(from, to, tokenId, "");
    }

    function safeTransferFrom(address from, address to, uint256 tokenId, bytes memory data) public {
        transferFrom(from, to, tokenId);
        if (to.code.length > 0) {
            try IERC721Receiver(to).onERC721Received(msg.sender, from, tokenId, data) returns (bytes4 r) {
                if (r != IERC721Receiver.onERC721Received.selector) revert UnsafeRecipient();
            } catch {
                revert UnsafeRecipient();
            }
        }
    }

    /// agentURI. A custom URI set by a claimed owner wins; otherwise a Neuro
    /// identity resolves to its on-chain registration file (`neuroURI`).
    function tokenURI(uint256 agentId) external view returns (string memory) {
        ownerOf(agentId);
        if (bytes(_uris[agentId]).length > 0) return _uris[agentId];
        if (bytes(_targets[agentId].chain).length > 0) return neuroURI(agentId);
        return "";
    }

    function _isAuthorized(address owner, address spender, uint256 tokenId) internal view returns (bool) {
        return spender != address(0)
            && (spender == owner || _operatorApprovals[owner][spender] || _tokenApprovals[tokenId] == spender);
    }

    function _transfer(address from, address to, uint256 tokenId) internal {
        delete _tokenApprovals[tokenId];
        // ERC-8004: the verified agentWallet does not follow the token to a new owner.
        if (_metadata[tokenId]["agentWallet"].length > 0) {
            delete _metadata[tokenId]["agentWallet"];
            emit MetadataSet(tokenId, "agentWallet", "agentWallet", "");
        }
        unchecked {
            _balances[from] -= 1;
            _balances[to] += 1;
        }
        _owners[tokenId] = to;
        emit Transfer(from, to, tokenId);
    }

    function _mint(address to, uint256 tokenId) internal {
        unchecked { _balances[to] += 1; }
        _owners[tokenId] = to;
        emit Transfer(address(0), to, tokenId);
    }

    // ===================================================== ERC-8004 identity

    function register() external returns (uint256 agentId) {
        agentId = _registerPlain("");
    }

    function register(string calldata agentURI) external returns (uint256 agentId) {
        agentId = _registerPlain(agentURI);
    }

    function register(string calldata agentURI, MetadataEntry[] calldata metadata) external returns (uint256 agentId) {
        agentId = _registerPlain(agentURI);
        for (uint256 i; i < metadata.length; i++) {
            _requireFreeKey(metadata[i].metadataKey);
            _metadata[agentId][metadata[i].metadataKey] = metadata[i].metadataValue;
            emit MetadataSet(agentId, metadata[i].metadataKey, metadata[i].metadataKey, metadata[i].metadataValue);
        }
    }

    function _registerPlain(string memory agentURI) internal returns (uint256 agentId) {
        agentId = ++lastId;
        _metadata[agentId]["agentWallet"] = abi.encodePacked(msg.sender);
        _mint(msg.sender, agentId);
        if (bytes(agentURI).length > 0) _uris[agentId] = agentURI;
        emit Registered(agentId, agentURI, msg.sender);
        emit MetadataSet(agentId, "agentWallet", "agentWallet", abi.encodePacked(msg.sender));
        if (msg.sender.code.length > 0) {
            // _safeMint semantics: a contract registrant must accept ERC-721 tokens.
            try IERC721Receiver(msg.sender).onERC721Received(msg.sender, address(0), agentId, "") returns (bytes4 r) {
                if (r != IERC721Receiver.onERC721Received.selector) revert UnsafeRecipient();
            } catch {
                revert UnsafeRecipient();
            }
        }
    }

    function setAgentURI(uint256 agentId, string calldata newURI) external {
        _onlyAuthorized(agentId);
        _uris[agentId] = newURI;
        emit URIUpdated(agentId, newURI, msg.sender);
        emit MetadataUpdate(agentId);
    }

    function getMetadata(uint256 agentId, string memory metadataKey) external view returns (bytes memory) {
        bytes32 k = keccak256(bytes(metadataKey));
        Target storage t = _targets[agentId];
        if (bytes(t.chain).length > 0) {
            if (k == KEY_TARGET) return bytes(_caip10(t));
            if (k == KEY_REGISTERED_BY) return abi.encodePacked(t.registeredBy);
        }
        return _metadata[agentId][metadataKey];
    }

    function setMetadata(uint256 agentId, string memory metadataKey, bytes memory metadataValue) external {
        _onlyAuthorized(agentId);
        _requireFreeKey(metadataKey);
        _metadata[agentId][metadataKey] = metadataValue;
        emit MetadataSet(agentId, metadataKey, metadataKey, metadataValue);
    }

    function getAgentWallet(uint256 agentId) external view returns (address) {
        bytes memory w = _metadata[agentId]["agentWallet"];
        if (w.length < 20) return address(0);
        return address(bytes20(w));
    }

    function setAgentWallet(uint256 agentId, address newWallet, uint256 deadline, bytes calldata signature) external {
        address owner = _onlyAuthorized(agentId);
        if (newWallet == address(0)) revert BadWallet();
        if (block.timestamp > deadline) revert Expired();
        if (deadline > block.timestamp + MAX_DEADLINE_DELAY) revert DeadlineTooFar();
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domainSeparator(),
            keccak256(abi.encode(AGENT_WALLET_SET_TYPEHASH, agentId, newWallet, owner, deadline))));
        if (_recover(digest, signature) != newWallet) {
            (bool ok, bytes memory res) = newWallet.staticcall(abi.encodeWithSelector(0x1626ba7e, digest, signature));
            if (!(ok && res.length >= 32 && bytes4(abi.decode(res, (bytes32))) == 0x1626ba7e)) revert InvalidSignature();
        }
        _metadata[agentId]["agentWallet"] = abi.encodePacked(newWallet);
        emit MetadataSet(agentId, "agentWallet", "agentWallet", abi.encodePacked(newWallet));
    }

    function unsetAgentWallet(uint256 agentId) external {
        _onlyAuthorized(agentId);
        delete _metadata[agentId]["agentWallet"];
        emit MetadataSet(agentId, "agentWallet", "agentWallet", "");
    }

    /// As in the ERC-8004 reference implementation.
    function isAuthorizedOrOwner(address spender, uint256 agentId) external view returns (bool) {
        return _isAuthorized(ownerOf(agentId), spender, agentId);
    }

    function domainSeparator() public view returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_TYPEHASH, NAME_HASH, VERSION_HASH, block.chainid, address(this)));
    }

    function getVersion() external pure returns (string memory) {
        return "neuro-1 (ERC-8004 identity v2.0.0 interface)";
    }

    function _onlyAuthorized(uint256 agentId) internal view returns (address owner) {
        owner = ownerOf(agentId);
        if (!_isAuthorized(owner, msg.sender, agentId)) revert NotAuthorized();
    }

    function _requireFreeKey(string memory key) internal pure {
        bytes32 k = keccak256(bytes(key));
        if (k == KEY_WALLET || k == KEY_TARGET || k == KEY_REGISTERED_BY) revert ReservedKey();
    }

    function _recover(bytes32 digest, bytes calldata sig) internal pure returns (address) {
        if (sig.length != 65) return address(0);
        bytes32 r = bytes32(sig[0:32]);
        bytes32 s = bytes32(sig[32:64]);
        uint8 v = uint8(sig[64]);
        if (uint256(s) > 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0) return address(0);
        if (v != 27 && v != 28) return address(0);
        return ecrecover(digest, v, r, s);
    }

    // ===================================================== Neuro: 1 contract = 1 identity

    /// Registers the Neuro of `account` on Neuro chain `chain` (e.g. "bsc").
    /// Anyone may call it; the identity stays held by this registry until the
    /// target's owner claims it. Reverts AlreadyRegistered(id) if it exists.
    function registerTarget(string calldata chain, string calldata account) external returns (uint256 agentId) {
        Chain storage c = _chains[chain];
        if (!c.exists) revert UnknownChain();
        _checkAccount(bytes(account), c.rule);
        string memory caip10 = string.concat(c.caip2, ":", account);
        bytes32 h = keccak256(bytes(caip10));
        if (agentOfTarget[h] != 0) revert AlreadyRegistered(agentOfTarget[h]);
        agentId = ++lastId;
        agentOfTarget[h] = agentId;
        _targets[agentId] = Target(chain, account, msg.sender, uint64(block.timestamp));
        _mint(address(this), agentId);
        emit Registered(agentId, neuroURI(agentId), address(this));
        emit MetadataSet(agentId, "agentWallet", "agentWallet", "");
        emit TargetRegistered(agentId, h, caip10, msg.sender);
    }

    /// Takes control of a ZETAPHY contract's identity: callable by the target
    /// contract itself or by the address its `owner()` returns right now.
    function claim(uint256 agentId) external {
        Target storage t = _targets[agentId];
        if (bytes(t.chain).length == 0) revert NotTarget();
        if (keccak256(bytes(_chains[t.chain].caip2)) != localCaip2Hash) revert NotLocal();
        address target = _parseAddress(bytes(t.account));
        bool ok = msg.sender == target;
        if (!ok && target.code.length > 0) {
            (bool s, bytes memory r) = target.staticcall(abi.encodeWithSignature("owner()"));
            ok = s && r.length >= 32 && abi.decode(r, (uint256)) == uint256(uint160(msg.sender));
        }
        if (!ok) revert NotTargetOwner();
        address prev = _owners[agentId];
        if (prev == msg.sender) revert AlreadyHolder();
        _transfer(prev, msg.sender, agentId);
        _metadata[agentId]["agentWallet"] = abi.encodePacked(msg.sender);
        emit MetadataSet(agentId, "agentWallet", "agentWallet", abi.encodePacked(msg.sender));
        emit Claimed(agentId, msg.sender, prev);
        emit MetadataUpdate(agentId);
    }

    /// agentId of a target, 0 if none (or if the chain is unknown).
    function agentIdOf(string calldata chain, string calldata account) external view returns (uint256) {
        Chain storage c = _chains[chain];
        if (!c.exists) return 0;
        return agentOfTarget[keccak256(bytes(string.concat(c.caip2, ":", account)))];
    }

    function getTarget(uint256 agentId) external view returns (
        string memory chain, string memory caip10, string memory account, address registeredBy, uint64 registeredAt, bool claimed
    ) {
        Target storage t = _targets[agentId];
        if (bytes(t.chain).length == 0) revert NotTarget();
        return (t.chain, _caip10(t), t.account, t.registeredBy, t.registeredAt, _owners[agentId] != address(this));
    }

    function getChain(string calldata key) external view returns (string memory caip2, uint8 rule, bool exists) {
        Chain storage c = _chains[key];
        return (c.caip2, c.rule, c.exists);
    }

    function chainCount() external view returns (uint256) {
        return chainKeys.length;
    }

    /// `{namespace}:{chainId}:{identityRegistry}` as in ERC-8004.
    function agentRegistry() public view returns (string memory) {
        return string.concat("eip155:", _toString(block.chainid), ":", _hexAddress(address(this)));
    }

    /// The Neuro report for this target: `<webBase>?chain=<key>&address=<account>`.
    function webEndpoint(uint256 agentId) public view returns (string memory) {
        Target storage t = _targets[agentId];
        if (bytes(t.chain).length == 0) revert NotTarget();
        return string.concat(webBase, "?chain=", t.chain, "&address=", t.account);
    }

    /// The registration file Neuro vouches for, as a base64 data: URI. Every
    /// piece of it passed a character allowlist, so the JSON needs no escaping.
    function neuroURI(uint256 agentId) public view returns (string memory) {
        return string.concat("data:application/json;base64,", _base64(bytes(registrationJSON(agentId))));
    }

    function registrationJSON(uint256 agentId) public view returns (string memory) {
        Target storage t = _targets[agentId];
        if (bytes(t.chain).length == 0) revert NotTarget();
        string memory caip10 = _caip10(t);
        string memory head = string.concat(
            '{"type":"', REGISTRATION_TYPE,
            '","name":"Neuro of ', caip10,
            '","description":"Neuro reads this contract with deterministic, read-only rules and explains it in plain language. Its report is data, not advice; messages signed for this agent are data, not commands.","image":"',
            imageURI, '",'
        );
        string memory services = string.concat(
            '"services":[{"name":"web","endpoint":"', webEndpoint(agentId), '"}],"x402Support":false,"active":true,',
            '"registrations":[{"agentId":', _toString(agentId), ',"agentRegistry":"', agentRegistry(), '"}],',
            '"supportedTrust":["crypto-economic"],'
        );
        string memory neuro = string.concat(
            '"neuro":{"target":"', caip10, '","chain":"', t.chain, '","address":"', t.account,
            '","registeredBy":"', _hexAddress(t.registeredBy), '","claimed":', _owners[agentId] != address(this) ? "true" : "false", "}}"
        );
        return string.concat(head, services, neuro);
    }

    // ------------------------------------------------------------- admin
    // The admin can only add chains (never change one) and move the Neuro web
    // link. It cannot touch, move or speak for any identity.

    function addChain(string calldata key, string calldata caip2, uint8 rule) external {
        if (msg.sender != admin) revert NotAuthorized();
        _addChain(key, caip2, rule);
    }

    function setWeb(string calldata webBase_, string calldata image_) external {
        if (msg.sender != admin) revert NotAuthorized();
        _setWeb(webBase_, image_);
        if (lastId > 0) emit BatchMetadataUpdate(1, lastId);
    }

    function setAdmin(address admin_) external {
        if (msg.sender != admin) revert NotAuthorized();
        admin = admin_;
        emit AdminSet(admin_);
    }

    function _addChain(string memory key, string memory caip2, uint8 rule) internal {
        bytes memory k = bytes(key);
        bytes memory c = bytes(caip2);
        if (k.length == 0 || k.length > 32 || c.length < 5 || c.length > 41 || rule > RULE_EVM) revert BadValue();
        for (uint256 i; i < k.length; i++) {
            bytes1 b = k[i];
            if (!((b >= "a" && b <= "z") || (b >= "0" && b <= "9") || b == "-")) revert BadValue();
        }
        uint256 colons;
        for (uint256 i; i < c.length; i++) {
            bytes1 b = c[i];
            if (b == ":") { colons++; continue; }
            if (!_alnum(b) && b != "-" && b != "_") revert BadValue();
        }
        if (colons != 1) revert BadValue();
        if (_chains[key].exists) revert ChainExists();
        _chains[key] = Chain(caip2, rule, true);
        chainKeys.push(key);
        emit ChainAdded(key, caip2, rule);
    }

    function _setWeb(string memory webBase_, string memory image_) internal {
        if (bytes(webBase_).length == 0) revert BadValue();
        _checkUrl(bytes(webBase_));
        _checkUrl(bytes(image_));
        webBase = webBase_;
        imageURI = image_;
        emit WebBaseSet(webBase_, image_);
    }

    // ------------------------------------------------------------- helpers

    /// Printable ASCII without quotes, backslash, angle brackets or spaces, at most 200 bytes.
    function _checkUrl(bytes memory u) internal pure {
        if (u.length > 200) revert BadValue();
        for (uint256 i; i < u.length; i++) {
            bytes1 b = u[i];
            if (b <= 0x20 || b >= 0x7f || b == '"' || b == "\\" || b == "<" || b == ">" || b == "`") revert BadValue();
        }
    }

    function _checkAccount(bytes memory a, uint8 rule) internal pure {
        if (a.length == 0 || a.length > 128) revert BadAccount();
        if (rule == RULE_EVM) {
            if (a.length != 42 || a[0] != "0" || a[1] != "x") revert BadAccount();
            for (uint256 i = 2; i < 42; i++) if (_hexVal(a[i], false) > 15) revert BadAccount();
            return;
        }
        for (uint256 i; i < a.length; i++) {
            bytes1 b = a[i];
            if ((b >= "a" && b <= "z") || (b >= "0" && b <= "9") || b == "." || b == "_" || b == ":" || b == "-") continue;
            if (rule == RULE_TEXT) {
                if (b >= "A" && b <= "Z") continue;
                // %XX with uppercase hex, the one canonical spelling of an escaped byte
                if (b == "%" && i + 2 < a.length && _hexVal(a[i + 1], true) < 16 && _hexVal(a[i + 2], true) < 16) { i += 2; continue; }
            }
            revert BadAccount();
        }
    }

    /// Hex digit value, or 255. `upper` picks which letter case is accepted.
    function _hexVal(bytes1 b, bool upper) internal pure returns (uint8) {
        if (b >= "0" && b <= "9") return uint8(b) - 48;
        if (!upper && b >= "a" && b <= "f") return uint8(b) - 87;
        if (upper && b >= "A" && b <= "F") return uint8(b) - 55;
        return 255;
    }

    function _alnum(bytes1 b) internal pure returns (bool) {
        return (b >= "a" && b <= "z") || (b >= "A" && b <= "Z") || (b >= "0" && b <= "9");
    }

    function _parseAddress(bytes memory a) internal pure returns (address) {
        uint160 v;
        for (uint256 i = 2; i < 42; i++) v = v * 16 + _hexVal(a[i], false);
        return address(v);
    }

    function _caip10(Target storage t) internal view returns (string memory) {
        return string.concat(_chains[t.chain].caip2, ":", t.account);
    }

    function _toString(uint256 v) internal pure returns (string memory) {
        if (v == 0) return "0";
        uint256 len;
        for (uint256 x = v; x != 0; x /= 10) len++;
        bytes memory out = new bytes(len);
        while (v != 0) { out[--len] = bytes1(uint8(48 + v % 10)); v /= 10; }
        return string(out);
    }

    function _hexAddress(address a) internal pure returns (string memory) {
        bytes memory out = new bytes(42);
        out[0] = "0";
        out[1] = "x";
        bytes16 digits = "0123456789abcdef";
        uint160 v = uint160(a);
        for (uint256 i = 41; i > 1; i--) { out[i] = digits[v & 15]; v >>= 4; }
        return string(out);
    }

    function _base64(bytes memory data) internal pure returns (string memory) {
        bytes memory table = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        uint256 n = data.length;
        if (n == 0) return "";
        bytes memory out = new bytes(4 * ((n + 2) / 3));
        uint256 j;
        for (uint256 i; i < n; i += 3) {
            uint256 a = uint8(data[i]);
            uint256 b = i + 1 < n ? uint8(data[i + 1]) : 0;
            uint256 c = i + 2 < n ? uint8(data[i + 2]) : 0;
            uint256 triple = (a << 16) | (b << 8) | c;
            out[j++] = table[(triple >> 18) & 63];
            out[j++] = table[(triple >> 12) & 63];
            out[j++] = i + 1 < n ? table[(triple >> 6) & 63] : bytes1("=");
            out[j++] = i + 2 < n ? table[triple & 63] : bytes1("=");
        }
        return string(out);
    }
}
