import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';
import { KNOWN_TOKENS, knownToken, lookalikeOf } from '../src/known-tokens.js';
import { analyze } from '../src/analyze.js';
import { explain } from '../src/explain.js';
import { readContract } from '../src/reader.js';
import { CHAINS, isChainAddress } from '../src/chains.js';
import { createLocalChain } from './helpers/local-chain.js';
import { pubkeyBytes } from '../src/solana.js';
import { normalizeType, longAddress } from '../src/move.js';
import { parseTonAddress } from '../src/ton.js';

// EIP-55: a mixed-case address encodes its own checksum, so a typo is caught.
function toChecksum(addr) {
  const a = addr.toLowerCase().replace(/^0x/, '');
  const h = bytesToHex(keccak_256(utf8ToBytes(a)));
  return '0x' + [...a].map((c, i) => (parseInt(h[i], 16) >= 8 ? c.toUpperCase() : c)).join('');
}

test('every registered address is well-formed for its chain (EIP-55 checksum / 32-byte base58)', () => {
  for (const [chain, list] of Object.entries(KNOWN_TOKENS)) {
    assert.ok(CHAINS[chain], `unknown chain ${chain}`);
    for (const t of list) {
      const kind = CHAINS[chain].kind;
      if (kind === 'solana') assert.equal(pubkeyBytes(t.address).length, 32, `${chain} ${t.symbol}`);
      else if (kind === 'sui' || kind === 'aptos') {
        const canon = t.address.includes('::') ? normalizeType(t.address) : longAddress(t.address);
        assert.equal(t.address, canon, `${chain} ${t.symbol} must be stored in 64-digit form`);
      } else if (kind === 'starknet') {
        assert.match(t.address, /^0x[0-9a-f]{64}$/, `${chain} ${t.symbol}`);
      } else if (kind === 'near') {
        assert.ok(isChainAddress('near', t.address), `${chain} ${t.symbol}`);
      } else if (kind === 'ton') {
        // The friendly form carries a CRC16 checksum, so a typo is caught.
        assert.equal(parseTonAddress(t.display).raw, t.address, `${chain} ${t.symbol}`);
      } else assert.equal(t.address, toChecksum(t.address), `${chain} ${t.symbol} address typo?`);
    }
  }
});

test('lookup is exact per chain and case-insensitive', () => {
  assert.equal(knownToken('bsc', '0x55d398326f99059ff775485246999027b3197955').symbol, 'USDT');
  assert.equal(knownToken('base', '0x55d398326f99059fF775485246999027B3197955'), null);
});

test('copied symbols are caught, including spaced and lower-case variants', () => {
  const other = '0x' + '12'.repeat(20);
  assert.equal(lookalikeOf('bsc', other, 'USDT').issuer, 'Tether (Binance-Peg)');
  assert.equal(lookalikeOf('bsc', other, 'u s d t').symbol, 'USDT');
  assert.equal(lookalikeOf('bsc', other, 'USD-T').symbol, 'USDT');
  assert.equal(lookalikeOf('bsc', '0x55d398326f99059fF775485246999027B3197955', 'USDT'), null, 'the real one is not a fake');
  assert.equal(lookalikeOf('base', other, 'USDT'), null, 'no official USDT registered on Base');
  assert.equal(lookalikeOf('bsc', other, 'MOON'), null);
});

test('official issuer: mint/freeze/upgrade become low and name the issuer', () => {
  const known = knownToken('bsc', '0x55d398326f99059fF775485246999027B3197955');
  const r = analyze({
    hasCode: true,
    functions: [
      { sig: 'symbol()', cat: 'erc20' }, { sig: 'owner()', cat: 'ownership' },
      { sig: 'mint(uint256)', cat: 'mint' }, { sig: 'pause()', cat: 'pause' },
    ],
    opcodes: {}, proxy: { kind: 'eip1967', implementation: '0x' + '1'.repeat(40) },
    token: { name: 'Tether USD', symbol: 'USDT', decimals: 18, totalSupply: '1' },
    owner: '0x' + 'f'.repeat(40), known,
  });
  const by = (id) => r.findings.find((f) => f.id === id);
  assert.equal(by('known-issuer').severity, 'good');
  for (const id of ['can-mint', 'can-pause', 'proxy-upgradeable']) {
    assert.equal(by(id).severity, 'low', id);
    assert.equal(by(id).params.issuer, 'Tether (Binance-Peg)');
  }
  assert.equal(r.level, 'low');
  const th = explain({ analysis: r }, 'th');
  assert.equal(th.lines[1].id, 'known-issuer', 'issuer line comes right after the token line');
  assert.match(th.lines.find((l) => l.id === 'can-mint').text, /Tether/);
});

let chain;
before(async () => { chain = await createLocalChain(); });

test('a token copying USDT on BNB Chain is flagged as a possible fake', async () => {
  const fake = await chain.deploy('FakeUSDT');
  const r = await readContract('bsc', fake, { rpc: chain.rpc });
  const f = r.analysis.findings.find((x) => x.id === 'lookalike');
  assert.equal(f.severity, 'high');
  assert.equal(f.params.official, '0x55d398326f99059fF775485246999027B3197955');
  assert.equal(r.analysis.level, 'high');
  assert.equal(explain(r, 'th').lines[1].id, 'lookalike');
});

test('the same contract on a chain without an official USDT is not called a fake', async () => {
  const fake = await chain.deploy('FakeUSDT');
  const r = await readContract('base', fake, { rpc: chain.rpc });
  assert.ok(!r.analysis.findings.some((x) => x.id === 'lookalike'));
});
