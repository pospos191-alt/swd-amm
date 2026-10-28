// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// TEST ONLY: a ThreatRegistry stand-in for RiskForecasts (flag by address on this chain, or as a contract).
contract MockFlags {
    mapping(address => bool) public byAddress;
    mapping(address => bool) public byCode;
    function setAddress(address who, bool on) external { byAddress[who] = on; }
    function setCode(address who, bool on) external { byCode[who] = on; }
    function isAddressFlagged(uint256, address who) external view returns (bool, uint8) { return (byAddress[who], byAddress[who] ? 3 : 0); }
    function isContractFlagged(address who) external view returns (bool, uint8) { return (byCode[who], byCode[who] ? 3 : 0); }
}
