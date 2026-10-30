// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// Test stand-ins for test/provenverdicts.test.js (compiled by the test, never deployed anywhere).

/// A "verifier" that accepts every proof (or none) for a chosen model hash. Used to show that ProvenVerdicts refuses a
/// verifier for another model, and to run the runner job's plumbing with proofs the rehearsal key cannot make.
contract FakeModelVerifier {
    bytes32 public MODEL_HASH;
    bool public answer;

    constructor(bytes32 h, bool a) {
        MODEL_HASH = h;
        answer = a;
    }

    function verifyModelProof(uint256[2] calldata, uint256[2][2] calldata, uint256[2] calldata, uint256, uint256) external view returns (bool) {
        return answer;
    }
}

/// A token-like contract with some code (its EXTCODEHASH is what a verdict records).
contract KitToken {
    mapping(address => uint256) public balanceOf;
    address public owner = msg.sender;

    function transfer(address to, uint256 v) external returns (bool) {
        balanceOf[msg.sender] -= v;
        balanceOf[to] += v;
        return true;
    }

    function mint(address to, uint256 v) external {
        require(msg.sender == owner, "owner");
        balanceOf[to] += v;
    }
}
