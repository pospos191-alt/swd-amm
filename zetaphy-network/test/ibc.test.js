// The IBC / Noble USDC kit without a chain (zetaphy-chain/gov.sh ibc-usdc-*,
// zetaphy-chain/ibc/setup-relayer.sh). The full proof on two devnets with a
// real Hermes is test/devnet.ibc.integration.js (npm run test:devnet:ibc).
//  - the voucher denom ibc/<SHA-256("transfer/<channel>/uusdc")>, checked
//    against a published one (Osmosis' USDC from Noble, cosmos/chain-registry)
//    and its ERC-20 address (Cosmos EVM v0.7.3 utils.GetIBCDenomAddress);
//  - the proposals gov.sh writes (MsgAddRateLimit with low defaults,
//    MsgToggleConversion, erc20 MsgUpdateParams), against a stand-in zetaphyd;
//  - the Hermes config setup-relayer.sh writes (eth_secp256k1 address type,
//    Noble testnet values) and its refusal of a Hermes download whose
//    SHA-256 does not match the pin.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const GOV = new URL('../../zetaphy-chain/gov.sh', import.meta.url).pathname;
const RELAYER = new URL('../../zetaphy-chain/ibc/setup-relayer.sh', import.meta.url).pathname;
const GOV_ADDR = 'zetaphy10d07y265gmmuvt4z0w9aw880jnsr700jhnar6e';

function run(script, args, env = {}) {
  const r = spawnSync('bash', [script, ...args], { encoding: 'utf8', env: { ...process.env, ...env } });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}
const usdc = (channel) => createHash('sha256').update(`transfer/${channel}/uusdc`).digest('hex').toUpperCase();

test('voucher denom and ERC-20 address', () => {
  // cosmos/chain-registry osmosis/assetlist.json: USDC.n, trace transfer/channel-750/uusdc.
  const { code, out } = run(GOV, ['ibc-usdc-denom', 'channel-750']);
  assert.equal(code, 0, out);
  assert.match(out, /^denom {2}ibc\/498A0751C798A0D9A389AA3691123DADA57DAA4FE165D5C75894505B876BA6E4$/m);
  // The ERC-20 is the last 20 bytes of the 32-byte hash (common.BytesToAddress).
  assert.match(out, /^erc20 {2}0x91123dada57daa4fe165d5c75894505b876ba6e4$/m);
  for (const ch of ['channel-0', 'channel-7', 'channel-12345']) {
    const r = run(GOV, ['ibc-usdc-denom', ch]);
    assert.match(r.out, new RegExp(`denom  ibc/${usdc(ch)}\n`));
    assert.match(r.out, new RegExp(`erc20  0x${usdc(ch).slice(24).toLowerCase()}\n`));
  }
  for (const bad of ['0', 'channel-x', 'transfer/channel-0', "channel-0'; id"]) {
    assert.notEqual(run(GOV, ['ibc-usdc-denom', bad]).code, 0, bad);
  }
});

test('bank metadata for the voucher: USDC with 6 decimals, valid for x/bank', () => {
  const { code, out } = run(GOV, ['ibc-usdc-metadata', 'channel-0']);
  assert.equal(code, 0, out);
  const m = JSON.parse(out);
  const denom = `ibc/${usdc('channel-0')}`;
  assert.equal(m.base, denom);
  assert.deepEqual(m.denom_units[0], { denom, exponent: 0, aliases: ['uusdc'] });
  // The ERC-20 precompile takes decimals from the unit named by display.
  assert.equal(m.display, 'usdc');
  assert.equal(m.denom_units.find((u) => u.denom === m.display).exponent, 6);
  assert.equal(m.symbol, 'USDC');
});

test('gov.sh usage lists every command, and only the header', () => {
  const { code, out } = run(GOV, []);
  assert.equal(code, 2);
  const lines = out.trimEnd().split('\n');
  assert.match(lines[0], /^ {2}gov\.sh propose-upgrade/);
  assert.match(lines.at(-1), /^ {2}gov\.sh ibc-usdc-metadata/);
  assert.ok(!lines.some((l) => l.startsWith('#') || l.startsWith('set ')), out);
  for (const c of ['ibc-usdc-denom', 'ibc-usdc-ratelimit', 'ibc-usdc-erc20', 'propose-ratelimit', 'vote-key']) {
    assert.ok(out.includes(`gov.sh ${c}`), c);
  }
});

// A stand-in zetaphyd: answers the queries gov.sh makes and keeps the
// proposal file it is asked to submit.
function fakeChain({ supply = '100000000', erc20On = true, pair = 'enabled', meta = 'none', limit = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'zetaphy-ibc-gov-'));
  const bin = join(dir, 'zetaphyd');
  writeFileSync(bin, `#!/bin/bash
D=${dir}
case "$1 $2 $3" in
  "q auth module-account") echo '{"account":{"value":{"address":"${GOV_ADDR}"}}}' ;;
  "q bank total-supply-of") echo "{\\"amount\\":{\\"denom\\":\\"$4\\",\\"amount\\":\\"${supply}\\"}}" ;;
  "q gov proposals"*) if [ -f $D/proposal.json ]; then echo '{"proposals":[{"id":"7"}]}'; else echo '{"proposals":[]}'; fi ;;
  "q erc20 params") echo '{"params":{"enable_erc20":${erc20On},"permissionless_registration":true}}' ;;
  "q erc20 token-pair")
    [ "${pair}" = none ] && { echo "not found" >&2; exit 1; }
    echo "{\\"token_pair\\":{\\"erc20_address\\":\\"0x$(echo \${4:28} | tr A-F a-f)\\",\\"denom\\":\\"$4\\",\\"enabled\\":${pair === 'enabled'}}}" ;;
  "q ratelimit list-rate-limits")
    if [ "${limit}" = true ]; then echo "{\\"rate_limits\\":[{\\"path\\":{\\"denom\\":\\"ibc/${usdc('channel-3')}\\",\\"channel_or_client_id\\":\\"channel-3\\"}}]}"
    else echo '{"rate_limits":[]}'; fi ;;
  "q bank denom-metadata")
    [ "${meta}" = none ] && exit 1
    # ibc-go v11's default (transfer keeper SetDenomMetadata)
    echo "{\\"metadata\\":{\\"base\\":\\"$4\\",\\"display\\":\\"transfer/channel-0/uusdc\\",\\"symbol\\":\\"UUSDC\\",\\"denom_units\\":[{\\"denom\\":\\"uusdc\\"}]}}" ;;
  "tx gov submit-proposal") cp "$4" $D/proposal.json; echo '{"code":0,"txhash":"AB"}' ;;
  *) echo "unexpected: $*" >&2; exit 1 ;;
esac
`);
  chmodSync(bin, 0o755);
  const env = { ZETAPHYD: bin, NODE_HOME: dir, KEYS_DIR: dir };
  const proposal = () => (existsSync(join(dir, 'proposal.json')) ? JSON.parse(readFileSync(join(dir, 'proposal.json'), 'utf8')) : null);
  return { env, proposal };
}

test('ibc-usdc-ratelimit: MsgAddRateLimit on the USDC voucher, 1% / 1% / 24 h by default', () => {
  const c = fakeChain();
  const { code, out } = run(GOV, ['ibc-usdc-ratelimit', 'channel-3'], c.env);
  assert.equal(code, 0, out);
  assert.match(out, /proposal 7 submitted/);
  const p = c.proposal();
  assert.deepEqual(p.messages, [{
    '@type': '/ratelimit.v1.MsgAddRateLimit', authority: GOV_ADDR, denom: `ibc/${usdc('channel-3')}`,
    channel_or_client_id: 'channel-3', max_percent_send: '1', max_percent_recv: '1', duration_hours: '24',
  }]);
  assert.equal(p.deposit, '1000000000000000000000azetaphy');

  const c2 = fakeChain();
  assert.equal(run(GOV, ['ibc-usdc-ratelimit', 'channel-3', '5', '10', '6'], c2.env).code, 0);
  const m = c2.proposal().messages[0];
  assert.deepEqual([m.max_percent_send, m.max_percent_recv, m.duration_hours], ['5', '10', '6']);

  for (const bad of [['101'], ['1', '-1'], ['1', '1', '0']]) {
    const c3 = fakeChain();
    assert.notEqual(run(GOV, ['ibc-usdc-ratelimit', 'channel-3', ...bad], c3.env).code, 0, bad.join(' '));
    assert.equal(c3.proposal(), null);
  }
});

test('ibc-usdc-ratelimit on a channel that already has a limit: MsgUpdateRateLimit', () => {
  const c = fakeChain({ limit: true });
  const { code, out } = run(GOV, ['ibc-usdc-ratelimit', 'channel-3', '5', '5', '12'], c.env);
  assert.equal(code, 0, out);
  assert.deepEqual(c.proposal().messages, [{
    '@type': '/ratelimit.v1.MsgUpdateRateLimit', authority: GOV_ADDR, denom: `ibc/${usdc('channel-3')}`,
    channel_or_client_id: 'channel-3', max_percent_send: '5', max_percent_recv: '5', duration_hours: '12',
  }]);
  assert.notEqual(run(GOV, ['ibc-usdc-ratelimit', 'channel-3', '500'], fakeChain({ limit: true }).env).code, 0);
});

test('ibc-usdc-ratelimit refuses while no USDC is on the chain (x/ratelimit needs a supply)', () => {
  const c = fakeChain({ supply: '0' });
  const { code, out } = run(GOV, ['ibc-usdc-ratelimit', 'channel-0'], c.env);
  assert.equal(code, 1);
  assert.match(out, /no USDC on ZETAPHY through channel-0 yet/);
  assert.match(out, /setup-relayer\.sh send-usdc/);
  assert.equal(c.proposal(), null);
});

test('ibc-usdc-erc20: address and token-list entry when registered', () => {
  const c = fakeChain();
  const { code, out } = run(GOV, ['ibc-usdc-erc20', 'channel-0'], { ...c.env, EVM_CHAIN_ID: '77390' });
  assert.equal(code, 0, out);
  const addr = '0x' + usdc('channel-0').slice(24).toLowerCase();
  assert.match(out, new RegExp(`is the ERC-20 ${addr}`));
  assert.doesNotMatch(out, /WARNING/);
  // ibc-go's default metadata makes decimals() 0: gov.sh says so.
  const d = run(GOV, ['ibc-usdc-erc20', 'channel-0'], fakeChain({ meta: 'default' }).env);
  assert.match(d.out, /WARNING: the chain reports 0 decimals/);
  assert.match(d.out, /gov\.sh ibc-usdc-metadata channel-0/);
  const entry = JSON.parse(out.slice(out.indexOf('{')));
  assert.deepEqual(entry, { chainId: 77390, address: addr, name: 'USD Coin (Noble)', symbol: 'USDC', decimals: 6,
    extensions: { cosmosDenom: `ibc/${usdc('channel-0')}`, origin: 'noble uusdc' } });
  assert.equal(c.proposal(), null);
});

test('ibc-usdc-erc20: not registered yet -> says the first transfer registers it (v0.7.3 has no proposal for it)', () => {
  const c = fakeChain({ pair: 'none' });
  const { code, out } = run(GOV, ['ibc-usdc-erc20', 'channel-0'], c.env);
  assert.equal(code, 1);
  assert.match(out, /first USDC that arrives through channel-0 makes it an ERC-20/);
  assert.ok(out.includes('0x' + usdc('channel-0').slice(24).toLowerCase()));
  assert.equal(c.proposal(), null);
});

test('ibc-usdc-erc20: paused -> MsgToggleConversion proposal', () => {
  const c = fakeChain({ pair: 'disabled' });
  const { code, out } = run(GOV, ['ibc-usdc-erc20', 'channel-0'], c.env);
  assert.equal(code, 0, out);
  assert.deepEqual(c.proposal().messages, [{ '@type': '/cosmos.evm.erc20.v1.MsgToggleConversion', authority: GOV_ADDR, token: `ibc/${usdc('channel-0')}` }]);
});

test('ibc-usdc-erc20: module off -> erc20 MsgUpdateParams that turns it on', () => {
  const c = fakeChain({ erc20On: false });
  const { code, out } = run(GOV, ['ibc-usdc-erc20', 'channel-0'], c.env);
  assert.equal(code, 0, out);
  assert.deepEqual(c.proposal().messages, [{ '@type': '/cosmos.evm.erc20.v1.MsgUpdateParams', authority: GOV_ADDR,
    params: { enable_erc20: true, permissionless_registration: true } }]);
});

// setup-relayer.sh with a stand-in hermes (accepts "config validate").
function relayerEnv(extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'zetaphy-ibc-relayer-'));
  const hermes = join(dir, 'hermes');
  writeFileSync(hermes, '#!/bin/bash\n[ "$3 $4" = "config validate" ] && exit 0\nexit 1\n');
  chmodSync(hermes, 0o755);
  return { dir, env: { AS_SELF: '1', NO_SYSTEMD: '1', HERMES_HOME: join(dir, 'h'), HERMES_BIN: hermes, ...extra } };
}

test('setup-relayer.sh config: ZETAPHY eth_secp256k1 keys, Noble testnet values', () => {
  const { dir, env } = relayerEnv();
  spawnSync('mkdir', ['-p', join(dir, 'h')]);
  const { code, out } = run(RELAYER, ['config'], env);
  assert.equal(code, 0, out);
  const toml = readFileSync(join(dir, 'h', 'config.toml'), 'utf8');
  const py = spawnSync('python3', ['-I', '-c', 'import sys, tomllib, json; print(json.dumps(tomllib.load(open(sys.argv[1], "rb"))))', join(dir, 'h', 'config.toml')], { encoding: 'utf8' });
  assert.equal(py.status, 0, py.stderr);
  const cfg = JSON.parse(py.stdout);
  const [z, n] = cfg.chains;
  assert.equal(z.id, 'zetaphy_77390-1');
  assert.equal(z.rpc_addr, 'http://127.0.0.1:26657');
  assert.equal(z.grpc_addr, 'http://127.0.0.1:9090');
  assert.equal(z.account_prefix, 'zetaphy');
  assert.deepEqual(z.address_type, { derivation: 'ethermint', proto_type: { pk_type: '/cosmos.evm.crypto.v1.ethsecp256k1.PubKey' } });
  assert.deepEqual(z.gas_price, { price: 2000000000, denom: 'azetaphy' });
  assert.equal(z.trusting_period, '14days');
  assert.equal(z.memo_prefix, 'ZETAPHY relayer');
  assert.equal(z.compat_mode, '0.37');
  assert.ok(!('compat_mode' in n));
  assert.equal(n.id, 'grand-1');
  assert.equal(n.account_prefix, 'noble');
  assert.deepEqual(n.address_type, { derivation: 'cosmos' });
  assert.deepEqual(n.gas_price, { price: 0.1, denom: 'uusdc' });
  assert.equal(n.rpc_addr, 'https://noble-testnet-rpc.polkachu.com:443');
  assert.equal(n.event_source.url, 'wss://noble-testnet-rpc.polkachu.com/websocket');
  assert.equal(n.trusting_period, '14days');
  assert.equal(cfg.telemetry.host, '127.0.0.1');
  assert.ok(!('packet_filter' in z), 'no filter before the channel exists');
  assert.ok(!/mnemonic|private/i.test(toml));

  // With a channel: relay only that one, on both sides.
  writeFileSync(join(dir, 'h', 'channel.env'), 'ZETAPHY_CHANNEL=channel-2\nNOBLE_CHANNEL=channel-91\n');
  assert.equal(run(RELAYER, ['config'], env).code, 0);
  const cfg2 = JSON.parse(spawnSync('python3', ['-I', '-c', 'import sys, tomllib, json; print(json.dumps(tomllib.load(open(sys.argv[1], "rb"))))', join(dir, 'h', 'config.toml')], { encoding: 'utf8' }).stdout);
  assert.deepEqual(cfg2.chains[0].packet_filter, { policy: 'allow', list: [['transfer', 'channel-2']] });
  assert.deepEqual(cfg2.chains[1].packet_filter, { policy: 'allow', list: [['transfer', 'channel-91']] });
});

test('setup-relayer.sh keeps settings given once (env) for later runs', () => {
  const { dir, env } = relayerEnv();
  spawnSync('mkdir', ['-p', join(dir, 'h')]);
  const read = () => readFileSync(join(dir, 'h', 'config.toml'), 'utf8');
  assert.equal(run(RELAYER, ['config'], { ...env, NOBLE_RPC: 'https://rpc.example.org:443', NOBLE_EVENTS: 'pull' }).code, 0);
  assert.equal(run(RELAYER, ['config'], env).code, 0);
  assert.match(read(), /rpc_addr = 'https:\/\/rpc\.example\.org:443'/);
  assert.match(read(), /event_source = \{ mode = 'pull'/);
  assert.equal(run(RELAYER, ['config'], { ...env, NOBLE_RPC: 'https://noble-testnet-rpc.polkachu.com:443' }).code, 0);
  assert.match(read(), /rpc_addr = 'https:\/\/noble-testnet-rpc\.polkachu\.com:443'/);
});

test('setup-relayer.sh refuses a Hermes download that does not match the pinned SHA-256', () => {
  const { dir, env } = relayerEnv();
  const tgz = join(dir, 'hermes.tar.gz');
  writeFileSync(tgz, 'not the release');
  const { code, out } = run(RELAYER, ['setup'], { ...env, HERMES_BIN: join(dir, 'bin-hermes'), HERMES_TARBALL: tgz });
  assert.notEqual(code, 0);
  assert.match(out, /does not match the pinned SHA-256: refused/);
  assert.ok(!existsSync(join(dir, 'bin-hermes')));
});

test('setup-relayer.sh usage lists every command, and only the header', () => {
  const { code, out } = run(RELAYER, ['help']);
  assert.equal(code, 2);
  const lines = out.trimEnd().split('\n');
  assert.match(lines[0], /^ {2}sudo bash setup-relayer\.sh {2,}install Hermes/);
  assert.match(lines.at(-1), /^ {2}sudo bash setup-relayer\.sh config/);
  for (const c of ['create-channel', 'start|stop', 'status', 'balances', 'addresses', 'send-usdc']) assert.ok(out.includes(`setup-relayer.sh ${c}`), c);
  assert.ok(!lines.some((l) => l.startsWith('#')), out);
});

test('setup-relayer.sh send-usdc checks its arguments before anything else', () => {
  const { env } = relayerEnv();
  for (const args of [['zetaphy1abc', '5'], ['0x' + '11'.repeat(20), '0'], ['0x' + '11'.repeat(20), '1.5'], ['cosmos1xyz', '5']]) {
    assert.notEqual(run(RELAYER, ['send-usdc', ...args], env).code, 0, args.join(' '));
  }
});
