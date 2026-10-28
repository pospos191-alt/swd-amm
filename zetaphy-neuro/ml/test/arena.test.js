// Red-vs-blue arena runner: red tokens judged in the in-memory sandbox (victim flow), blue specs scored.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { judgeRound, benignRows, keccakHex, checkRed } from '../redteam/arena.js';
import { seedSpec, SPEC_FORMAT } from '../detectors/spec.js';

const TOKEN = (name, extra, transferHook = '') => `// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
contract ${name} {
    string public name = "${name}";
    string public symbol = "${name.slice(0, 4).toUpperCase()}";
    uint8 public decimals = 18;
    uint256 public totalSupply;
    address public owner;
    address public pairAddr;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed o, address indexed s, uint256 v);
    constructor() { owner = msg.sender; totalSupply = 10**27; balanceOf[msg.sender] = 10**27; }
    function approve(address s, uint256 v) external returns (bool) { allowance[msg.sender][s] = v; emit Approval(msg.sender, s, v); return true; }
    function transfer(address to, uint256 v) external returns (bool) { _move(msg.sender, to, v); return true; }
    function transferFrom(address f, address to, uint256 v) external returns (bool) {
        uint256 a = allowance[f][msg.sender];
        if (a != type(uint256).max) { require(a >= v, "allowance"); allowance[f][msg.sender] = a - v; }
        _move(f, to, v); return true;
    }
    ${extra}
    function _move(address f, address to, uint256 v) internal {
        require(balanceOf[f] >= v, "balance");
        ${transferHook}
        balanceOf[f] -= v; balanceOf[to] += v; emit Transfer(f, to, v);
    }
}`;

const red = (index, manifest, { tamper = false } = {}) => {
  const content = JSON.stringify(manifest);
  return { index, revealed: true, contentHash: keccakHex(tamper ? content + ' ' : content), content };
};

test('arena: manifests are checked before anything is compiled', () => {
  assert.throws(() => checkRed({ format: 'x' }), /format/);
  assert.throws(() => checkRed({ format: 'arena-red/1', source: 'contract A {}', token: 'A' }), /source/);
  assert.throws(() => checkRed({ format: 'arena-red/1', source: 'pragma solidity 0.8.26; contract A {}', token: 'A', trap: [{ call: 'selfdestruct()' + ';x' }] }), /bad call/);
  assert.doesNotThrow(() => checkRed({ format: 'arena-red/1', source: 'pragma solidity 0.8.26; contract A {}', token: 'A', trap: [{ call: 'setFee(uint256)', args: ['1'] }, { dump: true }] }));
});

test('arena: a fee switch flipped after the scan is a working scam; a plain token is not; blue scored', { timeout: 180_000 }, async () => {
  const feeSwitch = TOKEN('Feeswitch',
    'uint256 public sellFee; function setPair(address p) external { require(msg.sender == owner); pairAddr = p; } function setSellFee(uint256 f) external { require(msg.sender == owner); sellFee = f; }',
    'if (to == pairAddr && sellFee > 0 && f != owner) { uint256 cut = v * sellFee / 10000; balanceOf[f] -= cut; balanceOf[owner] += cut; v -= cut; }');
  const plain = TOKEN('Plaintoken', '');
  const round = {
    round: 7,
    red: [
      red(0, { format: 'arena-red/1', source: feeSwitch, token: 'Feeswitch', trap: [{ call: 'setPair(address)', args: ['pair'] }, { call: 'setSellFee(uint256)', args: ['9900'] }] }),
      red(1, { format: 'arena-red/1', source: plain, token: 'Plaintoken', trap: [] }),
      red(2, { format: 'arena-red/1', source: plain, token: 'Plaintoken', trap: [] }, { tamper: true }),
      { index: 3, revealed: false },
      red(4, { format: 'arena-red/1', source: 'pragma solidity 0.8.26; contract Broken { function x( }', token: 'Broken' }),
    ],
    blue: [
      { index: 0, revealed: true, contentHash: keccakHex(JSON.stringify(seedSpec())), content: JSON.stringify(seedSpec()) },
      { index: 1, revealed: true, ...(() => { const c = JSON.stringify({ format: SPEC_FORMAT, bias: 5, rules: [{ feature: 'o_size', op: '>=', threshold: 0, weight: 0 }] }); return { content: c, contentHash: keccakHex(c) }; })() },
      { index: 2, revealed: false },
    ],
  };
  const benign = await benignRows(1, ['plain', 'small-tax']);
  assert.equal(benign.length, 2);
  const res = await judgeRound(round, { benign });
  const r = Object.fromEntries(res.red.map((x) => [x.index, x]));
  assert.equal(r[0].valid, true, r[0].reason);
  if (process.env.ARENA_DEBUG) console.log(JSON.stringify(res.red), JSON.stringify(res.blue));
  assert.match(r[0].reason, /victim got \d+ of \d+ quoted/);
  assert.equal(r[1].valid, false, r[1].reason);
  assert.equal(r[2].reason, 'content does not match its hash');
  assert.equal(r[3].reason, 'not revealed');
  assert.match(r[4].reason, /^rejected/);
  for (const x of res.red) assert.ok(!x.evaded || x.valid, 'evaded implies valid');
  // blue: "always flags" catches the valid red but flags both benign tokens
  const b = Object.fromEntries(res.blue.map((x) => [x.index, x]));
  assert.equal(b[1].caught, 1); assert.equal(b[1].falsePositives, 2); assert.equal(b[1].score, 1 - 4);
  assert.equal(b[2].score, 0);
  assert.equal(b[0].score, b[0].caught - 2 * b[0].falsePositives);
  assert.equal(res.args.redValid, '0x1');
  assert.equal(res.args.redEvaded, r[0].evaded ? '0x1' : '0x0');
  assert.deepEqual(res.args.blueScore, res.blue.map((x) => x.score));
  assert.equal(res.dataset.length, 1);
  assert.equal(res.dataset[0].label, 1); assert.equal(res.dataset[0].src, 'arena');
  assert.ok(Object.keys(res.dataset[0].f).length > 5, 'features for training');
});
