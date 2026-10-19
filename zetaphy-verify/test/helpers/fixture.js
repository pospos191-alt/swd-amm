// Compiles a small launcher (factory + token with constructor args and
// immutables) and fakes what a chain and the explorers would return.

import solc from 'solc';

export const SOURCES = {
  'contracts/LaunchToken.sol': `// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
contract LaunchToken {
    address public immutable factory;
    uint16 public immutable sellTaxBps;
    string public name;
    mapping(address => uint256) public balanceOf;
    constructor(string memory n, uint16 tax, address to, uint256 supply) {
        factory = msg.sender; sellTaxBps = tax; name = n; balanceOf[to] = supply;
    }
    function lowerTaxes(uint16 b, uint16 s) external pure returns (uint16) { return b < s ? b : s; }
}`,
  'contracts/LaunchFactory.sol': `// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import "./LaunchToken.sol";
contract LaunchFactory {
    event TokenDeployed(address indexed token, address indexed creator);
    function deploy(string calldata n, uint16 tax, uint256 supply) external returns (address t) {
        t = address(new LaunchToken(n, tax, msg.sender, supply));
        emit TokenDeployed(t, msg.sender);
    }
}`,
};

export const LONG_VERSION = '0.8.26+commit.8a97fa7a';

export function compile() {
  const input = {
    language: 'Solidity',
    sources: Object.fromEntries(Object.entries(SOURCES).map(([k, content]) => [k, { content }])),
    settings: {
      optimizer: { enabled: true, runs: 200 },
      outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object', 'evm.deployedBytecode.immutableReferences', 'metadata'] } },
    },
  };
  const output = JSON.parse(solc.compile(JSON.stringify(input)));
  const errors = (output.errors ?? []).filter((e) => e.severity === 'error');
  if (errors.length) throw new Error(errors.map((e) => e.formattedMessage).join('\n'));
  // Hardhat 2 build-info shape
  return { _format: 'hh-sol-build-info-1', solcVersion: '0.8.26', solcLongVersion: LONG_VERSION, input, output };
}

/** The runtime code as the chain would hold it: immutables filled in. */
export function deployedRuntime(buildInfo, source, name, fill = 'ab') {
  const c = buildInfo.output.contracts[source][name].evm.deployedBytecode;
  const hex = c.object.split('');
  for (const refs of Object.values(c.immutableReferences ?? {})) {
    for (const { start, length } of refs) for (let i = 0; i < length * 2; i++) hex[start * 2 + i] = fill[i % fill.length];
  }
  return '0x' + hex.join('');
}

export const word = (hex) => hex.replace(/^0x/, '').padStart(64, '0');

/** ABI-encode (string, uint16, address, uint256) like the factory does. */
export function encodeArgs(n, tax, to, supply) {
  const bytes = Buffer.from(n, 'utf8');
  const padded = bytes.toString('hex').padEnd(Math.ceil(bytes.length / 32) * 64, '0');
  return word((128).toString(16)) + word(tax.toString(16)) + word(to) + word(supply.toString(16))
    + word(bytes.length.toString(16)) + padded;
}

/** Fake RPC: code by address, logs, block number; records calls. */
export function fakeRpc({ code = {}, logs = [], latest = 1000, chainId = 56, maxRange = Infinity } = {}) {
  const calls = [];
  return {
    calls,
    async call(method, params) {
      calls.push([method, params]);
      if (method === 'eth_chainId') return '0x' + chainId.toString(16);
      if (method === 'eth_getCode') return code[params[0].toLowerCase()] ?? '0x';
      if (method === 'eth_blockNumber') return '0x' + latest.toString(16);
      if (method === 'eth_getLogs') {
        const { fromBlock, toBlock, address, topics } = params[0];
        const from = Number(fromBlock), to = Number(toBlock);
        if (to - from + 1 > maxRange) throw new Error('block range too large');
        return logs.filter((l) => l.blockNumber >= from && l.blockNumber <= to
          && address.includes(l.address) && l.topics[0] === topics[0]);
      }
      throw new Error(`unexpected ${method}`);
    },
  };
}

const reply = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

/**
 * Fake Sourcify + Etherscan V2. `state.verified` is a Set of "explorer:chain:address".
 * `opts.planBlocked` lists chain ids where Etherscan answers like its free tier.
 */
export function fakeExplorers({ creation = {}, planBlocked = [], sourcifyFails = false } = {}) {
  const state = { verified: new Set(), submissions: [] };
  let n = 0;
  const jobs = new Map();
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    if (u.host === 'sourcify.dev') {
      let m;
      if ((m = u.pathname.match(/^\/server\/v2\/contract\/(\d+)\/(0x[0-9a-f]{40})$/))) {
        return state.verified.has(`sourcify:${m[1]}:${m[2]}`) ? reply(200, { match: 'match' }) : reply(404, {});
      }
      if ((m = u.pathname.match(/^\/server\/v2\/verify\/(\d+)\/(0x[0-9a-f]{40})$/)) && init.method === 'POST') {
        const body = JSON.parse(init.body);
        state.submissions.push({ explorer: 'sourcify', chainId: m[1], address: m[2], body });
        const id = `job-${++n}`;
        jobs.set(id, { key: `sourcify:${m[1]}:${m[2]}`, fail: sourcifyFails });
        return reply(202, { verificationId: id });
      }
      if ((m = u.pathname.match(/^\/server\/v2\/verify\/(job-\d+)$/))) {
        const j = jobs.get(m[1]);
        if (j.fail) return reply(200, { isJobCompleted: true, error: { message: 'bytecode mismatch' } });
        state.verified.add(j.key);
        return reply(200, { isJobCompleted: true, contract: { match: 'exact_match' } });
      }
    }
    if (u.host === 'api.etherscan.io') {
      const chainId = u.searchParams.get('chainid');
      const p = init.method === 'POST' ? new URLSearchParams(init.body) : u.searchParams;
      if (planBlocked.includes(Number(chainId))) {
        return reply(200, { status: '0', message: 'NOTOK', result: 'Free API access is not supported for this chain. Please upgrade your api plan for full chain coverage.' });
      }
      const action = p.get('action');
      if (action === 'getsourcecode') {
        const v = state.verified.has(`etherscan:${chainId}:${p.get('address')}`);
        return reply(200, { status: '1', result: [{ SourceCode: v ? 'pragma solidity...' : '' }] });
      }
      if (action === 'getcontractcreation') {
        const a = p.get('contractaddresses');
        return reply(200, { status: '1', result: creation[a] ? [{ contractAddress: a, txHash: '0x' + '1'.repeat(64), creationBytecode: creation[a] }] : null });
      }
      if (action === 'verifysourcecode') {
        state.submissions.push({ explorer: 'etherscan', chainId, address: p.get('contractaddress'), form: Object.fromEntries(p) });
        const guid = `guid-${++n}`;
        jobs.set(guid, { key: `etherscan:${chainId}:${p.get('contractaddress')}` });
        return reply(200, { status: '1', message: 'OK', result: guid });
      }
      if (action === 'checkverifystatus') {
        const j = jobs.get(p.get('guid'));
        if (!j.polled) { j.polled = true; return reply(200, { status: '0', result: 'Pending in queue' }); }
        state.verified.add(j.key);
        return reply(200, { status: '1', result: 'Pass - Verified' });
      }
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  return { state, fetchImpl };
}
