// Solana reader tests. Address math is cross-checked against the official
// @solana/web3.js library; account data uses the RPC's jsonParsed shapes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';
import {
  base58Decode, base58Encode, pubkeyBytes, isOnCurve, findProgramAddress, parseMetaplexMetadata,
  METADATA_PROGRAM, TOKEN_PROGRAM, TOKEN_2022_PROGRAM, UPGRADEABLE_LOADER,
} from '../src/solana.js';
import { readContract } from '../src/reader.js';
import { createSolanaRpc } from '../src/rpc.js';
import { CHAINS, isChainAddress } from '../src/chains.js';
import { explain } from '../src/explain.js';

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const key = () => new PublicKey(randomBytes(32)).toBase58();
const ids = (r) => r.analysis.findings.map((f) => f.id);
const find = (r, id) => r.analysis.findings.find((f) => f.id === id);

test('base58 round-trips and matches web3.js', () => {
  for (let i = 0; i < 50; i++) {
    const b = randomBytes(32);
    const s = new PublicKey(b).toBase58();
    assert.equal(base58Encode(b), s);
    assert.deepEqual([...base58Decode(s)], [...b]);
  }
  assert.equal(base58Encode(new Uint8Array(32)), '11111111111111111111111111111111');
  assert.throws(() => pubkeyBytes('0OIl'));
  assert.throws(() => pubkeyBytes('abc'), /invalid address/);
});

test('curve check agrees with web3.js on random bytes and real keys', () => {
  for (let i = 0; i < 300; i++) {
    const b = randomBytes(32);
    assert.equal(isOnCurve(b), PublicKey.isOnCurve(b), Buffer.from(b).toString('hex'));
  }
  assert.equal(isOnCurve(pubkeyBytes(USDC)), PublicKey.isOnCurve(new PublicKey(USDC).toBytes()));
});

test('program addresses match web3.js (Metaplex metadata of USDC and random seeds)', async () => {
  const seeds = [Buffer.from('metadata'), new PublicKey(METADATA_PROGRAM).toBuffer(), new PublicKey(USDC).toBuffer()];
  const [want] = PublicKey.findProgramAddressSync(seeds, new PublicKey(METADATA_PROGRAM));
  assert.equal(await findProgramAddress(seeds.map((s) => new Uint8Array(s)), METADATA_PROGRAM), want.toBase58());
  for (let i = 0; i < 20; i++) {
    const s = [randomBytes(1 + (i % 32))];
    const prog = key();
    const [w] = PublicKey.findProgramAddressSync(s, new PublicKey(prog));
    assert.equal(await findProgramAddress(s.map((x) => new Uint8Array(x)), prog), w.toBase58());
  }
});

// ---- Metaplex metadata account bytes
function metaplexAccount({ name, symbol, updateAuthority, isMutable, creators = 0 }) {
  const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
  const str = (s, pad) => { const v = Buffer.alloc(pad); Buffer.from(s).copy(v); return Buffer.concat([u32(pad), v]); };
  return Buffer.concat([
    Buffer.from([4]), new PublicKey(updateAuthority).toBuffer(), randomBytes(32),
    str(name, 32), str(symbol, 10), str('https://x', 200), Buffer.from([0, 0]),
    creators ? Buffer.concat([Buffer.from([1]), u32(creators), randomBytes(34 * creators)]) : Buffer.from([0]),
    Buffer.from([1, isMutable ? 1 : 0]),
  ]);
}

test('parses Metaplex metadata, with and without creators', () => {
  const ua = key();
  for (const creators of [0, 2]) {
    const m = parseMetaplexMetadata(new Uint8Array(metaplexAccount({ name: 'Bonk', symbol: 'BONK', updateAuthority: ua, isMutable: creators === 2, creators })));
    assert.deepEqual(m, { name: 'Bonk', symbol: 'BONK', updateAuthority: ua, isMutable: creators === 2 });
  }
});

// ---- a fake Solana RPC built from account fixtures
function fakeSolana(accounts) {
  const calls = [];
  return {
    calls,
    async call(method, params) {
      calls.push(method);
      if (method !== 'getAccountInfo') throw new Error(`unexpected ${method}`);
      const a = accounts[params[0]];
      return { value: a ? (params[1].encoding === 'base64' ? a.b64 : a.parsed) : null };
    },
  };
}
const mintAccount = (owner, info) => ({ parsed: { owner, data: { program: 'spl-token', parsed: { type: 'mint', info } } } });
const base64Account = (owner, bytes) => ({ b64: { owner, data: [Buffer.from(bytes).toString('base64'), 'base64'] } });
async function metadataPda(mint) {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('metadata'), new PublicKey(METADATA_PROGRAM).toBuffer(), new PublicKey(mint).toBuffer()], new PublicKey(METADATA_PROGRAM));
  return pda.toBase58();
}

test('Token-2022 mint with every risky power: each one is flagged', async () => {
  const mint = key(); const auth = key();
  const rpc = fakeSolana({
    [mint]: mintAccount(TOKEN_2022_PROGRAM, {
      decimals: 9, supply: '1000000000000000000', mintAuthority: auth, freezeAuthority: auth, isInitialized: true,
      extensions: [
        { extension: 'permanentDelegate', state: { delegate: auth } },
        { extension: 'transferFeeConfig', state: { transferFeeConfigAuthority: auth, withdrawWithheldAuthority: auth, withheldAmount: 0,
          olderTransferFee: { epoch: 1, maximumFee: 1e18, transferFeeBasisPoints: 100 },
          newerTransferFee: { epoch: 2, maximumFee: 1e18, transferFeeBasisPoints: 1500 } } },
        { extension: 'transferHook', state: { authority: auth, programId: key() } },
        { extension: 'defaultAccountState', state: { accountState: 'frozen' } },
        { extension: 'tokenMetadata', state: { updateAuthority: auth, mint, name: 'Free SOL at claim-sol.xyz', symbol: 'FREE', uri: '', additionalMetadata: [] } },
      ],
    }),
  });
  const r = await readContract('sol', mint, { rpc });
  assert.equal(r.analysis.level, 'high');
  for (const id of ['sol-mint-authority', 'sol-freeze-authority', 'sol-permanent-delegate', 'sol-transfer-fee',
    'sol-transfer-hook', 'sol-default-frozen', 'sol-metadata-mutable', 'name-has-link']) assert.ok(ids(r).includes(id), id);
  assert.equal(find(r, 'sol-transfer-fee').params.percent, 15, 'uses the newer fee');
  assert.equal(find(r, 'sol-transfer-fee').severity, 'high');
  assert.equal(r.solana.program, 'Token-2022');
  assert.deepEqual(rpc.calls, ['getAccountInfo'], 'metadata came from the extension, no extra lookup');
  assert.match(explain(r, 'th').lines.find((l) => l.id === 'sol-permanent-delegate').text, /เสี่ยงสูงมากต่อผู้ถือ/);
});

test('classic SPL token with authorities renounced and frozen metadata: no risk', async () => {
  const mint = key();
  const rpc = fakeSolana({
    [mint]: mintAccount(TOKEN_PROGRAM, { decimals: 6, supply: '5000000000', mintAuthority: null, freezeAuthority: null, isInitialized: true }),
    [await metadataPda(mint)]: base64Account(METADATA_PROGRAM, metaplexAccount({ name: 'Fair Coin', symbol: 'FAIR', updateAuthority: key(), isMutable: false })),
  });
  const r = await readContract('sol', mint, { rpc });
  assert.equal(r.analysis.level, 'info');
  assert.deepEqual(r.token, { name: 'Fair Coin', symbol: 'FAIR', decimals: 6, supply: '5000000000' });
  assert.ok(ids(r).includes('sol-mint-renounced') && ids(r).includes('sol-freeze-renounced'));
  assert.ok(!ids(r).includes('sol-metadata-mutable'));
  assert.match(explain(r, 'en').lines[0].text, /5,000/);
});

test('official USDC: issuer powers are low and named; a copy elsewhere is a fake', async () => {
  const circle = key();
  const usdcRpc = fakeSolana({
    [USDC]: mintAccount(TOKEN_PROGRAM, { decimals: 6, supply: '1', mintAuthority: circle, freezeAuthority: circle, isInitialized: true }),
    [await metadataPda(USDC)]: base64Account(METADATA_PROGRAM, metaplexAccount({ name: 'USD Coin', symbol: 'USDC', updateAuthority: circle, isMutable: true })),
  });
  const real = await readContract('sol', USDC, { rpc: usdcRpc });
  assert.equal(find(real, 'known-issuer').params.issuer, 'Circle');
  assert.equal(find(real, 'sol-mint-authority').severity, 'low');
  assert.equal(real.analysis.level, 'low');

  const fake = key();
  const fakeRpc = fakeSolana({
    [fake]: mintAccount(TOKEN_PROGRAM, { decimals: 6, supply: '1', mintAuthority: null, freezeAuthority: null, isInitialized: true }),
    [await metadataPda(fake)]: base64Account(METADATA_PROGRAM, metaplexAccount({ name: 'USD Coin', symbol: 'USDC', updateAuthority: key(), isMutable: false })),
  });
  const r = await readContract('sol', fake, { rpc: fakeRpc });
  assert.equal(find(r, 'lookalike').severity, 'high');
  assert.equal(find(r, 'lookalike').params.official, USDC);
});

test('programs: upgradeable vs immutable; wallets and missing accounts', async () => {
  const prog = key(); const data = key(); const authority = key();
  const programData = (auth) => Buffer.concat([Buffer.from([3, 0, 0, 0]), Buffer.alloc(8),
    auth ? Buffer.concat([Buffer.from([1]), new PublicKey(auth).toBuffer()]) : Buffer.alloc(33)]);
  const programAcc = { parsed: { owner: UPGRADEABLE_LOADER, executable: true, data: { program: 'bpf-upgradeable-loader', parsed: { type: 'program', info: { programData: data } } } } };

  let r = await readContract('sol', prog, { rpc: fakeSolana({ [prog]: programAcc, [data]: base64Account(UPGRADEABLE_LOADER, programData(authority)) }) });
  assert.equal(find(r, 'sol-program-upgradeable').params.authority, authority);
  r = await readContract('sol', prog, { rpc: fakeSolana({ [prog]: programAcc, [data]: base64Account(UPGRADEABLE_LOADER, programData(null)) }) });
  assert.ok(ids(r).includes('sol-program-immutable'));

  const wallet = key();
  r = await readContract('sol', wallet, { rpc: fakeSolana({ [wallet]: { parsed: { owner: '11111111111111111111111111111111', data: ['', 'base64'] } } }) });
  assert.equal(find(r, 'sol-not-token').params.owner, '11111111111111111111111111111111');
  r = await readContract('sol', key(), { rpc: fakeSolana({}) });
  assert.ok(ids(r).includes('sol-not-found'));
});

test('Solana RPC: refuses other clusters and anything that writes', async () => {
  const fetchImpl = async (url, init) => {
    const { method } = JSON.parse(init.body);
    const result = method === 'getGenesisHash' ? (url.includes('dev') ? 'devnet-hash' : CHAINS.sol.genesisHash) : { value: null };
    return { ok: true, json: async () => ({ result }) };
  };
  const rpc = createSolanaRpc(['https://dev.example', 'https://main.example'], CHAINS.sol.genesisHash, { fetchImpl });
  assert.deepEqual(await rpc.call('getAccountInfo', [USDC, {}]), { value: null });
  await assert.rejects(rpc.call('sendTransaction', ['x']), /not allowed/);
  await assert.rejects(rpc.call('requestAirdrop', ['x', 1]), /not allowed/);
});

test('address format is checked per chain', () => {
  assert.ok(isChainAddress('sol', USDC));
  assert.ok(!isChainAddress('sol', '0x55d398326f99059fF775485246999027B3197955'));
  assert.ok(!isChainAddress('bsc', USDC));
  assert.ok(isChainAddress('eth', '0xdAC17F958D2ee523a2206206994597C13D831ec7'));
});
