// Per-function path features (ml/flow.js) on small contracts compiled here with solc 0.8.26, with and without the
// optimizer: owner-only token movers (drain, uncapped mint) vs a capped mint, a fake renounce, environment checks
// inside transfer(), and the bounds that keep a hostile input from hanging the walk.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import solc from 'solc';
import { flowFeatures, FLOW_FEATURES } from '../flow.js';
import { FEATURES, extractFeatures } from '../features.js';
import { SELECTORS } from '../../src/selectors.generated.js';

const known = (s) => SELECTORS[s] != null;

const BASE = `
  mapping(address => uint256) internal _b;
  uint256 internal _s;
  event Transfer(address indexed from, address indexed to, uint256 value);
  function totalSupply() external view returns (uint256) { return _s; }
  function balanceOf(address a) external view returns (uint256) { return _b[a]; }
  function _move(address f, address t, uint256 v) internal { _b[f] -= v; _b[t] += v; emit Transfer(f, t, v); }
  function _mint(address t, uint256 v) internal { _s += v; _b[t] += v; emit Transfer(address(0), t, v); }
`;
const OWNED = `address public owner; modifier onlyOwner() { require(msg.sender == owner, "auth"); _; } constructor() { owner = msg.sender; }`;
const SRC = `// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
contract Plain { ${BASE} ${OWNED}
  function transfer(address t, uint256 v) external returns (bool) { _move(msg.sender, t, v); return true; } }
contract Drain { ${BASE} ${OWNED}
  function transfer(address t, uint256 v) external returns (bool) { _move(msg.sender, t, v); return true; }
  function q7x(address a, address t, uint256 v) external onlyOwner { _move(a, t, v); } }
contract FreeMint { ${BASE} ${OWNED}
  function transfer(address t, uint256 v) external returns (bool) { _move(msg.sender, t, v); return true; }
  function z9k(address t, uint256 v) external onlyOwner { _mint(t, v); } }
contract CappedMint { ${BASE} ${OWNED}
  function transfer(address t, uint256 v) external returns (bool) { _move(msg.sender, t, v); return true; }
  function z9k(address t, uint256 v) external onlyOwner { require(_s + v <= 2000000000 * 1e18, "cap"); _mint(t, v); } }
contract FakeRenounce { ${BASE}
  address private _a; constructor() { _a = msg.sender; }
  function owner() external pure returns (address) { return address(0); }
  function transfer(address t, uint256 v) external returns (bool) { _move(msg.sender, t, v); return true; }
  function k2p(address a) external { require(msg.sender == _a, "auth"); _move(a, msg.sender, _b[a]); } }
contract HashedOwner { ${BASE}
  bytes32 private _h; constructor() { _h = keccak256(abi.encode(msg.sender)); }
  function transfer(address t, uint256 v) external returns (bool) { _move(msg.sender, t, v); return true; }
  function k2p(address a) external { require(keccak256(abi.encode(msg.sender)) == _h, "auth"); _move(a, msg.sender, _b[a]); } }
contract TimeBomb { ${BASE} ${OWNED}
  uint256 private _t0; address private _lp;
  function setLp(address p) external onlyOwner { _lp = p; }
  function transfer(address t, uint256 v) external returns (bool) {
    require(t != _lp || msg.sender == owner || block.timestamp < _t0 + 3 days, "late"); _move(msg.sender, t, v); return true; } }
contract GasPrice { ${BASE}
  function transfer(address t, uint256 v) external returns (bool) { require(tx.gasprice == 0 || t != address(1), "x"); _move(msg.sender, t, v); return true; } }
`;

function compile(optimize) {
  const out = JSON.parse(solc.compile(JSON.stringify({
    language: 'Solidity', sources: { 'f.sol': { content: SRC } },
    settings: { optimizer: { enabled: optimize, runs: 200 }, outputSelection: { '*': { '*': ['evm.deployedBytecode.object'] } } },
  })));
  const errors = (out.errors ?? []).filter((e) => e.severity === 'error');
  if (errors.length) throw new Error(errors.map((e) => e.formattedMessage).join('\n'));
  return Object.fromEntries(Object.entries(out.contracts['f.sol']).map(([k, v]) => ['0x' + v.evm.deployedBytecode.object, k]).map(([c, k]) => [k, c]));
}
const BINS = { opt: compile(true), noopt: compile(false) };
const ff = (code) => flowFeatures(code, { known });

test('flow features are part of FEATURES, finite, and zero without code', () => {
  for (const n of FLOW_FEATURES) assert.ok(FEATURES.includes(n), n);
  for (const v of Object.values(flowFeatures('0x'))) assert.equal(v, 0);
  for (const v of Object.values(flowFeatures('0xzz'))) assert.equal(v, 0);
  const f = extractFeatures({ code: BINS.opt.Drain });
  for (const n of FLOW_FEATURES) assert.ok(Number.isFinite(f[n]), n);
  assert.deepEqual(ff(BINS.opt.Drain), ff(BINS.opt.Drain), 'deterministic');
});

for (const [mode, B] of Object.entries(BINS)) {
  test(`${mode}: owner-only functions that move or create tokens, with and without a fixed cap`, () => {
    const plain = ff(B.Plain);
    assert.equal(plain.x_fn_found, 1);
    assert.equal(plain.x_tx_found, 1);
    assert.equal(plain.x_priv_xfer, 0);
    assert.ok(plain.x_fn_xfer > 0, 'transfer moves tokens');
    for (const name of ['Drain', 'FreeMint']) {
      const f = ff(B[name]);
      assert.ok(f.x_priv_xfer > 0 && f.x_priv_xfer_unknown > 0 && f.x_priv_xfer_free > 0, name);
      assert.equal(f.x_priv_capped, 0, name);
    }
    const capped = ff(B.CappedMint);
    assert.ok(capped.x_priv_xfer > 0);
    assert.equal(capped.x_priv_xfer_free, 0, 'the cap is seen');
    assert.ok(capped.x_priv_capped > 0);
  });

  test(`${mode}: hidden owners (fake renounce, hashed) are still owners`, () => {
    const fake = ff(B.FakeRenounce);
    assert.equal(fake.x_owner_const, 1);
    assert.equal(fake.x_fake_renounce, 1);
    assert.ok(fake.x_priv_xfer_free > 0);
    assert.equal(ff(B.Plain).x_owner_const, 0, 'a stored owner is not a constant');
    assert.ok(ff(B.HashedOwner).x_priv_xfer_free > 0);
  });

  test(`${mode}: what transfer() depends on`, () => {
    const t = ff(B.TimeBomb);
    assert.equal(t.x_tx_time, 1);
    assert.equal(t.x_tx_guard, 1, 'owner exemption inside transfer');
    assert.equal(ff(B.Plain).x_tx_time, 0);
    assert.equal(ff(B.Plain).x_tx_guard, 0);
    assert.equal(ff(B.GasPrice).x_tx_gasprice, 1);
    assert.equal(ff(B.Plain).x_tx_gasprice, 0);
  });
}

test('bounded: a jump maze ends quickly and gives finite numbers', () => {
  // dispatcher entry for transfer -> a long chain of JUMPDEST/JUMPI loops back to itself
  const body = [];
  for (let i = 0; i < 400; i++) body.push(0x5b, 0x42, 0x61, 0x00, 0x12, 0x57);
  const code = '0x' + [0x60, 0x00, 0x35, 0x60, 0xe0, 0x1c, 0x80, 0x63, 0xa9, 0x05, 0x9c, 0xbb, 0x14, 0x61, 0x00, 0x12, 0x57, 0x00, ...body, 0x00].map((b) => b.toString(16).padStart(2, '0')).join('');
  const t0 = Date.now();
  const f = flowFeatures(code);
  assert.ok(Date.now() - t0 < 2000);
  assert.equal(f.x_tx_found, 1);
  assert.equal(f.x_tx_time, 1);
  for (const v of Object.values(f)) assert.ok(Number.isFinite(v));
});

test('path checks (ml/checks.js): fire on owner powers found by following the code, not on a plain token', async () => {
  const { runChecks, checksRank, CHECKS } = await import('../checks.js');
  for (const c of CHECKS) assert.ok(FEATURES.includes(c.feature), c.feature);
  const feats = (code) => extractFeatures({ code });
  assert.deepEqual(runChecks(feats(BINS.opt.Plain)), []);
  assert.deepEqual(runChecks(feats(BINS.opt.CappedMint)), [], 'a capped mint is not flagged');
  assert.deepEqual(runChecks(feats(BINS.opt.Drain)).map((c) => c.id), ['owner-moves-tokens']);
  assert.deepEqual(runChecks(feats(BINS.noopt.FakeRenounce)).map((c) => c.id).sort(), ['hidden-owner', 'owner-moves-tokens']);
  assert.equal(checksRank(feats(BINS.opt.FreeMint)), 2);
  assert.match(runChecks(feats(BINS.opt.Drain), 'th')[0].label, /เจ้าของ/);
});
