// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

interface ISpvClient {
    function verifyTx(bytes calldata rawTx, bytes32 blockHash, uint256 index, bytes32[] calldata siblings, uint256 minConfirmations)
        external view returns (bytes32 txid);
}

interface ISpvAirlock {
    function attest(uint256 srcChainId, address srcContract, uint256 srcNonce, address sender, address to, uint256 amount) external;
}

/// @title BtcSpvLane: Bitcoin deposits to ZETAPHY, attested by proof of work instead of by signers
/// @notice A lane of a BTC route's BridgeAirlock (docs/SAPHAN-PROOFS.md), testnet only, not audited.
///         A deposit is a Bitcoin transaction (its non-witness serialization: what the txid hashes) with
///           - an output paying `custodyScript` (the route's custody, e.g. a federation's P2WSH), and
///           - an OP_RETURN output: "ZTPHY" (5 bytes) || the 20-byte ZETAPHY recipient.
///         Anyone hands it in with its block and Merkle branch; BtcLightClient checks the inclusion on the
///         heaviest chain with `minConfirmations`. The lane then attests to the airlock:
///           (BTC_CHAIN_ID, the custody's id, keccak256(txid, output index), sender 0, recipient, sats x 10^10)
///         (the bridged token has 18 decimals). The airlock still needs its other independent lane(s), the
///         quarantine and the threat checks before anything mints. Each (txid, output) attests once (the
///         airlock refuses a lane's second attestation of the same transfer).
///         What it does not do: send BTC back (that needs keys on Bitcoin; after an external audit).
contract BtcSpvLane {
    uint256 public constant BTC_CHAIN_ID = 0x425443;      // "BTC": the source "chain id" in transfer ids
    bytes5 public constant TAG = "ZTPHY";
    uint256 public constant SATS_TO_WEI = 1e10;

    ISpvClient public immutable client;
    ISpvAirlock public immutable airlock;
    bytes32 public immutable custodyHash;   // keccak256 of the custody output's scriptPubKey
    address public immutable custodyId;     // the transfer ids' "source contract": address(uint160(custodyHash))
    uint256 public immutable minConfirmations;
    uint256 public immutable minSats;

    event Deposit(bytes32 indexed txid, uint32 vout, address indexed to, uint64 sats);

    error BadTx(uint256 code); // 1 truncated 2 no custody output 3 no tag 4 too small 5 output index
    error NotCustody();

    constructor(ISpvClient client_, ISpvAirlock airlock_, bytes memory custodyScript, uint256 minConfirmations_, uint256 minSats_) {
        require(address(client_) != address(0) && address(airlock_) != address(0) && custodyScript.length > 0 && minConfirmations_ >= 1, "config");
        client = client_;
        airlock = airlock_;
        custodyHash = keccak256(custodyScript);
        custodyId = address(uint160(uint256(keccak256(custodyScript))));
        minConfirmations = minConfirmations_;
        minSats = minSats_;
    }

    /// Anyone: proves a deposit (output `vout` pays the custody) and attests it to the airlock.
    function attest(bytes calldata rawTx, uint32 vout, bytes32 blockHash, uint256 index, bytes32[] calldata siblings) external {
        (uint64 sats, address to) = parse(rawTx, vout);
        bytes32 txid = client.verifyTx(rawTx, blockHash, index, siblings, minConfirmations);
        emit Deposit(txid, vout, to, sats);
        airlock.attest(BTC_CHAIN_ID, custodyId, uint256(keccak256(abi.encode(txid, vout))), address(0), to, uint256(sats) * SATS_TO_WEI);
    }

    /// Output `vout`'s value when it pays the custody, and the recipient of the transaction's tagged OP_RETURN.
    function parse(bytes calldata t, uint32 vout) public view returns (uint64 sats, address to) {
        uint256 p = 4;                                    // version
        uint256 n;
        (n, p) = _varint(t, p);                           // inputs
        for (uint256 i = 0; i < n; i++) {
            p += 36;                                      // outpoint
            uint256 len;
            (len, p) = _varint(t, p);
            p += len + 4;                                 // script, sequence
        }
        uint256 outs;
        (outs, p) = _varint(t, p);
        if (vout >= outs) revert BadTx(5);
        bool paid;
        for (uint256 i = 0; i < outs; i++) {
            if (p + 8 > t.length) revert BadTx(1);
            uint64 value = _le64(t, p);
            p += 8;
            uint256 len;
            (len, p) = _varint(t, p);
            if (p + len > t.length) revert BadTx(1);
            bytes calldata script = t[p:p + len];
            if (i == vout) {
                if (keccak256(script) != custodyHash) revert BadTx(2);
                sats = value;
                paid = true;
            } else if (len == 27 && script[0] == 0x6a && script[1] == 0x19 && bytes5(script[2:7]) == TAG) {
                to = address(bytes20(script[7:27]));      // OP_RETURN, push 25: "ZTPHY" || recipient
            }
            p += len;
        }
        if (p + 4 != t.length) revert BadTx(1);           // locktime, nothing after
        if (!paid) revert BadTx(2);
        if (to == address(0)) revert BadTx(3);
        if (sats < minSats) revert BadTx(4);
    }

    function _varint(bytes calldata t, uint256 p) private pure returns (uint256 v, uint256 q) {
        if (p >= t.length) revert BadTx(1);
        uint8 f = uint8(t[p]);
        if (f < 0xfd) return (f, p + 1);
        uint256 size = f == 0xfd ? 2 : f == 0xfe ? 4 : 8;
        if (p + 1 + size > t.length) revert BadTx(1);
        for (uint256 i = 0; i < size; i++) v |= uint256(uint8(t[p + 1 + i])) << (8 * i);
        q = p + 1 + size;
    }

    function _le64(bytes calldata t, uint256 p) private pure returns (uint64 v) {
        for (uint256 i = 0; i < 8; i++) v |= uint64(uint8(t[p + i])) << uint64(8 * i);
    }
}
