// Anchor IDL reader. Address math is cross-checked against @solana/web3.js;
// the account bytes are built the way the Anchor CLI writes them
// (8-byte discriminator, authority, u32 length, zlib-compressed JSON).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { PublicKey } from '@solana/web3.js';
import { createWithSeed, idlAddress, parseIdlAccount, idlFacts } from '../src/anchor.js';
import { readContract } from '../src/reader.js';
import { UPGRADEABLE_LOADER } from '../src/solana.js';
import { explain } from '../src/explain.js';

const key = () => new PublicKey(randomBytes(32)).toBase58();
const ids = (r) => r.analysis.findings.map((f) => f.id);
const find = (r, id) => r.analysis.findings.find((f) => f.id === id);

function idlAccount(authority, idl) {
  const z = deflateSync(Buffer.from(JSON.stringify(idl)));
  const len = Buffer.alloc(4); len.writeUInt32LE(z.length);
  return Buffer.concat([randomBytes(8), new PublicKey(authority).toBuffer(), len, z]);
}

// Anchor 0.30+ format: snake_case names, `signer: true`.
const NEW_IDL = {
  address: 'x', metadata: { name: 'meme_vault', version: '0.1.0', spec: '0.1.0' },
  instructions: [
    { name: 'deposit', discriminator: [1], accounts: [{ name: 'user', signer: true, writable: true }], args: [] },
    { name: 'mint_tokens', discriminator: [2], accounts: [{ name: 'admin', signer: true }], args: [] },
    { name: 'set_paused', discriminator: [3], accounts: [{ name: 'config', accounts: [{ name: 'pause_authority', signer: true }] }], args: [] },
    { name: 'withdraw_fees', discriminator: [4], accounts: [{ name: 'fee_authority', signer: true }], args: [] },
    // The user signing for their own tokens is not an admin (Jupiter's swaps).
    { name: 'swap', discriminator: [6], accounts: [{ name: 'user_transfer_authority', signer: true }, { name: 'owner', signer: true }], args: [] },
    { name: 'bad name<script>', discriminator: [5], accounts: [], args: [] },
  ],
};
// Legacy format: camelCase names, `isSigner`.
const OLD_IDL = {
  version: '0.1.0', name: 'old_pool',
  instructions: [
    { name: 'swap', accounts: [{ name: 'user', isMut: true, isSigner: true }], args: [] },
    { name: 'freezeAccount', accounts: [{ name: 'freezeAuthority', isMut: false, isSigner: true }], args: [] },
    { name: 'setFeeRate', accounts: [{ name: 'admin', isMut: false, isSigner: true }], args: [] },
  ],
};

test('IDL address matches web3.js createWithSeed(findProgramAddress([]), "anchor:idl")', async () => {
  for (let i = 0; i < 10; i++) {
    const prog = key();
    const [base] = PublicKey.findProgramAddressSync([], new PublicKey(prog));
    const want = await PublicKey.createWithSeed(base, 'anchor:idl', new PublicKey(prog));
    assert.equal(await idlAddress(prog), want.toBase58());
    const b = key();
    assert.equal(await createWithSeed(b, 'seed', prog), (await PublicKey.createWithSeed(new PublicKey(b), 'seed', new PublicKey(prog))).toBase58());
  }
});

test('IDL account is decoded and both IDL formats give the same kind of facts', async () => {
  const auth = key();
  const { authority, idl } = await parseIdlAccount(new Uint8Array(idlAccount(auth, NEW_IDL)));
  assert.equal(authority, auth);
  const f = idlFacts(idl);
  assert.equal(f.name, 'meme_vault');
  assert.equal(f.instructions, 5, 'names that are not plain identifiers are dropped');
  assert.deepEqual(f.admin, ['mint_tokens', 'set_paused', 'withdraw_fees'], 'nested account groups are searched');
  assert.deepEqual(f.powers.mint, ['meme_vault::mint_tokens']);
  assert.deepEqual(f.powers.pause, ['meme_vault::set_paused']);

  const old = idlFacts(OLD_IDL);
  assert.equal(old.name, 'old_pool');
  assert.deepEqual(old.admin, ['freeze_account', 'set_fee_rate']);
  assert.deepEqual(old.powers.blacklist, ['old_pool::freeze_account']);
  assert.deepEqual(old.powers.fee, ['old_pool::set_fee_rate']);
  await assert.rejects(parseIdlAccount(new Uint8Array(20)), /bad IDL/);
});

test('a program with an IDL: admin instructions and powers are reported', async () => {
  const prog = key(); const data = key(); const upgrade = key();
  const programAcc = { owner: UPGRADEABLE_LOADER, executable: true, data: { program: 'bpf-upgradeable-loader', parsed: { type: 'program', info: { programData: data } } } };
  const programData = Buffer.concat([Buffer.from([3, 0, 0, 0]), Buffer.alloc(8), Buffer.from([1]), new PublicKey(upgrade).toBuffer()]);
  const idlAddr = await idlAddress(prog);
  const b64 = (owner, bytes) => ({ owner, data: [Buffer.from(bytes).toString('base64'), 'base64'] });
  const accounts = { [prog]: programAcc, [data]: b64(UPGRADEABLE_LOADER, programData), [idlAddr]: b64(prog, idlAccount(key(), NEW_IDL)) };
  const rpc = { call: async (m, [addr]) => ({ value: accounts[addr] ?? null }) };
  const r = await readContract('sol', prog, { rpc });
  assert.equal(find(r, 'sol-idl').params.count, 5);
  assert.deepEqual(find(r, 'sol-admin-instructions').params.functions, ['mint_tokens', 'set_paused', 'withdraw_fees']);
  assert.ok(ids(r).includes('can-pause'));
  assert.equal(r.solana.idl.name, 'meme_vault');
  assert.match(explain(r, 'th').lines.map((l) => l.text).join(' '), /meme_vault/);

  // An "IDL" not owned by the program is ignored (anyone can create accounts).
  accounts[idlAddr] = b64(key(), idlAccount(key(), NEW_IDL));
  const spoof = await readContract('sol', prog, { rpc });
  assert.ok(ids(spoof).includes('sol-no-idl'));
});
