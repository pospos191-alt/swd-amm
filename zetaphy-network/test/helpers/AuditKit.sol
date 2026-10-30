// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

interface IKitNet {
    function bond() external payable;
    function commitReport(uint256 id, bytes32 commitment) external;
    function revealReport(uint256 id, bytes32 hash, bytes32 salt) external;
    function claimReport(uint256 id) external;
    function withdraw() external;
}

/// TEST ONLY: an auditor contract whose receive() re-enters AuditNetwork.withdraw once.
contract AuditReenter {
    IKitNet public immutable net;
    bool public armed;
    bool public reentryFailed;
    uint256 public received;

    constructor(IKitNet net_) payable { net = net_; }

    function bond() external payable { net.bond{value: msg.value}(); }
    function commitReport(uint256 id, bytes32 c) external { net.commitReport(id, c); }
    function revealReport(uint256 id, bytes32 h, bytes32 s) external { net.revealReport(id, h, s); }
    function claimReport(uint256 id) external { net.claimReport(id); }
    function attack() external { armed = true; net.withdraw(); }

    receive() external payable {
        received += msg.value;
        if (armed) {
            armed = false;
            try net.withdraw() {} catch { reentryFailed = true; }
        }
    }
}
