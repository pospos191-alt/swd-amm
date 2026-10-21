// On-chain randomness and the 0x…dEaD burn on a real single-validator ZETAPHY
// chain (zetaphyd with the stage-5 patch, vote extensions on from block 1):
//   - block.prevrandao changes every block, is never 0 or 1, and is what the
//     chain documents: without a vote key, sha256 over the previous block's
//     hash (fallback); once the validator registers its ML-DSA-44 vote key,
//     sha256 over the post-quantum certificate in tx[0] of the block
//   - a transaction sees the same value as eth_call on that block
//   - BLOCKHASH(n-1) is the real CometBFT hash of block n-1
//   - ZETAPHY sent to 0x…dEaD leaves the total supply within a few blocks
//   - the EIP-2935 history contract, called directly, returns the real hashes
//   - all of these are on from block 1 (genesis activation height, key 08 of
//     app_state.zetaphypq, written by `zetaphyd init`)
// Needs a zetaphyd built with the patch:
//   ZETAPHYD=/path/to/zetaphyd npm run test:devnet:chainrand

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Wallet, JsonRpcProvider, parseEther, getBytes, hexlify, concat, toBeHex, zeroPadValue } from 'ethers';
import { sha256 } from '@noble/hashes/sha2.js';
import { decodeCertificate, cometClient } from '../src/pqcert.js';

const ZETAPHYD = process.env.ZETAPHYD || 'zetaphyd';
const PORT = 22545; // EVM JSON-RPC (+1 ws); CometBFT +100, p2p +101, gRPC +102, REST +103, metrics +104
const EVM_RPC = `http://127.0.0.1:${PORT}`;
const COMET = `http://127.0.0.1:${PORT + 100}`;
const CHAIN = 'zetaphy-chainrand-1';
const DENOM = 'azetaphy';
const DEAD = '0x000000000000000000000000000000000000dEaD';
const root = mkdtempSync(join(tmpdir(), 'zetaphy-chainrand-'));
const H = join(root, 'chain');
const env = { ...process.env, NO_PROXY: '127.0.0.1', no_proxy: '127.0.0.1' };
const funder = Wallet.createRandom();
const comet = cometClient(COMET);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let provider, wallet, probe;

// One validator, vote extensions from block 1 (ML-DSA-44 vote signatures),
// the same genesis settings as scripts/devnet.sh (no inflation), JSON-RPC on.
const SETUP = String.raw`
set -euo pipefail
BIN=$ZETAPHYD; W=$1; P=$2; FUND=$3; C=zetaphy-chainrand-1; D=azetaphy; K="--keyring-backend test --home $W"
$BIN init chainrand --chain-id $C --home "$W" >/dev/null 2>&1
$BIN keys add validator $K --algo eth_secp256k1 >/dev/null 2>&1
G="$W/config/genesis.json"
jq ".app_state.staking.params.bond_denom=\"$D\" | .app_state.evm.params.evm_denom=\"$D\" | .app_state.mint.params.mint_denom=\"$D\" | .app_state.gov.params.min_deposit[0].denom=\"$D\" | .app_state.gov.params.expedited_min_deposit[0].denom=\"$D\"
  | .app_state.bank.denom_metadata=[{description:\"ZETAPHY\",denom_units:[{denom:\"$D\",exponent:0},{denom:\"zetaphy\",exponent:18}],base:\"$D\",display:\"zetaphy\",name:\"ZETAPHY\",symbol:\"ZETAPHY\"}]
  | .app_state.mint.minter.inflation=\"0.000000000000000000\" | .app_state.mint.params.inflation_rate_change=\"0.000000000000000000\" | .app_state.mint.params.inflation_max=\"0.000000000000000000\" | .app_state.mint.params.inflation_min=\"0.000000000000000000\"
  | .consensus.params.block.max_gas=\"30000000\" | .consensus.params.abci.vote_extensions_enable_height=\"1\"" "$G" > "$G.t" && mv "$G.t" "$G"
$BIN genesis add-genesis-account "$($BIN keys show validator -a $K)" "100000000000000000000000000$D" --home "$W"
$BIN genesis add-genesis-account "$($BIN debug addr "$FUND" --home "$W" | awk '/Bech32 Acc/ {print $3}')" "1000000000000000000000000$D" --home "$W"
$BIN genesis gentx validator "10000000000000000000000000$D" $K --chain-id $C --gas-prices "1000000000$D" >/dev/null 2>&1
$BIN genesis collect-gentxs --home "$W" >/dev/null 2>&1
sed -i -E "s/^timeout_commit = .*/timeout_commit = \"1s\"/; s/^type = \"flood\"/type = \"app\"/; s#^laddr = \"tcp://127.0.0.1:26657\"#laddr = \"tcp://127.0.0.1:$((P+100))\"#; s#^laddr = \"tcp://0.0.0.0:26656\"#laddr = \"tcp://127.0.0.1:$((P+101))\"#; s#^pprof_laddr = .*#pprof_laddr = \"\"#" "$W/config/config.toml"
python3 - "$W/config/app.toml" "$P" "$D" <<'PY'
import re, sys
p, port, d = sys.argv[1], int(sys.argv[2]), sys.argv[3]; s = open(p).read()
s = re.sub(r'(?m)^minimum-gas-prices = .*', f'minimum-gas-prices = "1000000000{d}"', s)
s = re.sub(r'(?m)^evm-chain-id = .*', 'evm-chain-id = 77390', s)
s = re.sub(r'(?m)^geth-metrics-address = .*', f'geth-metrics-address = "127.0.0.1:{port+104}"', s)
for sec, key, val in [('json-rpc', 'enable', 'true'), ('json-rpc', 'address', f'"127.0.0.1:{port}"'), ('json-rpc', 'ws-address', f'"127.0.0.1:{port+1}"'),
                      ('grpc', 'address', f'"127.0.0.1:{port+102}"'), ('api', 'address', f'"tcp://127.0.0.1:{port+103}"')]:
    s = re.sub(rf'(?ms)(^\[{sec}\].*?^{key} = )\S+', rf'\g<1>{val}', s)
open(p, 'w').write(s)
PY
(umask 077 && od -An -tx1 -N32 /dev/urandom | tr -d ' \n' > "$W/config/pq_vote_key.seed")
nohup $BIN start --home "$W" --chain-id $C --json-rpc.api eth,net,web3 > "$W/node.log" 2>&1 &
echo $! > "$W/node.pid"
for _ in $(seq 1 90); do
  if curl -s -m 2 -X POST -H 'content-type: application/json' --data '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}' "http://127.0.0.1:$P" | grep -q '"result":"0x[1-9a-f]'; then exit 0; fi
  sleep 1
done
echo "devnet did not start"; tail -20 "$W/node.log"; exit 1
`;

before(() => {
  execFileSync('bash', ['-c', SETUP, 'setup', H, String(PORT), funder.address], { stdio: 'inherit', env: { ...env, ZETAPHYD } });
  provider = new JsonRpcProvider(EVM_RPC, undefined, { staticNetwork: true, pollingInterval: 250 });
  wallet = funder.connect(provider);
});
after(() => {
  try { process.kill(Number(readFileSync(join(H, 'node.pid'), 'utf8'))); } catch { /* gone */ }
  if (!process.env.KEEP) setTimeout(() => rmSync(root, { recursive: true, force: true, maxRetries: 5 }), 2000).unref();
});

const cometHeight = async () => Number((await comet('status', {})).sync_info.latest_block_height);
async function waitHeight(h, ms = 60_000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(300)) if (await cometHeight() >= h) return;
  throw new Error(`the chain did not reach block ${h}`);
}
// Only this test sends from funder, one tx at a time: count nonces here (a
// node's 'latest' count can lag the receipt by a moment).
let nextNonce;
const nonce = async () => { nextNonce ??= await provider.getTransactionCount(funder.address, 'latest'); return nextNonce++; };
const blockHash = async (h) => hexlify(Buffer.from((await comet('block', { height: String(h) })).block_id.hash, 'hex'));

// eth_call of init code: returns 0x00 || prevrandao || blockhash(number-1) ||
// number of the block queried. The leading zero byte keeps the "deployed
// code" from starting with 0xEF, which EIP-3541 refuses (1 in 256 values).
const READ = '0x44602052' + '43600190034060405243606052' + '6061601ff3';
async function readAt(h) {
  const out = getBytes(await provider.call({ data: READ, blockTag: h }));
  assert.equal(out.length, 97);
  assert.equal(out[0], 0);
  return { rnd: hexlify(out.slice(1, 33)), prevHash: hexlify(out.slice(33, 65)), number: Number(BigInt(hexlify(out.slice(65, 97)))) };
}

// The chain's formula (evmd/zetaphy_random.go).
const u64 = (n) => getBytes(zeroPadValue(toBeHex(BigInt(n)), 8));
const head = (h) => concat([new TextEncoder().encode('zetaphy.prevrandao.v1'), '0x00', new TextEncoder().encode(CHAIN), '0x00', u64(h)]);
const fallbackRandao = (h, prevHash) => hexlify(sha256(getBytes(concat([head(h), '0x00', prevHash]))));
const certRandao = (h, cert) => hexlify(sha256(getBytes(concat([head(h), '0x01', u64(cert.height), cert.attestations]))));
async function certIn(h) {
  const txs = (await comet('block', { height: String(h) })).block.data.txs ?? [];
  return txs.length ? decodeCertificate(Buffer.from(txs[0], 'base64')) : null;
}

// Probe contract: each call logs (prevrandao, blockhash(number-1)) as its two topics.
//   NUMBER PUSH1 1 SWAP1 SUB BLOCKHASH PREVRANDAO PUSH0 PUSH0 LOG2 STOP
const RUNTIME = '436001900340445f5fa200';
async function deployProbe() {
  const code = getBytes('0x' + RUNTIME);
  const init = concat(['0x60', toBeHex(code.length), '0x600a5f3960', toBeHex(code.length), '0x5ff3', code]);
  const rc = await (await wallet.sendTransaction({ data: init, gasLimit: 200_000, nonce: await nonce() })).wait();
  assert.equal(rc.status, 1);
  return rc.contractAddress;
}
async function poke() {
  const rc = await (await wallet.sendTransaction({ to: probe, gasLimit: 100_000, nonce: await nonce() })).wait();
  assert.equal(rc.status, 1);
  const [rnd, prevHash] = rc.logs[0].topics;
  return { height: rc.blockNumber, rnd, prevHash };
}

function checkDistinct(values) {
  assert.equal(new Set(values).size, values.length, `prevrandao repeats: ${values.join(' ')}`);
  for (const v of values) {
    assert.notEqual(BigInt(v), 0n);
    assert.notEqual(BigInt(v), 1n);
    assert.notEqual(BigInt(v), 2n ** 256n - 1n, 'the upstream constant');
  }
}

test('without a vote key: fallback prevrandao from the previous block hash, new every block; BLOCKHASH works', { timeout: 120_000 }, async () => {
  probe = await deployProbe();
  await waitHeight(7);
  const tip = await cometHeight();
  const seen = [];
  for (let h = tip - 4; h <= tip; h++) {
    const r = await readAt(h);
    assert.equal(r.number, h);
    assert.equal(await certIn(h), null, `block ${h} has no certificate yet`);
    const prev = await blockHash(h - 1);
    assert.equal(r.prevHash, prev, `BLOCKHASH(${h - 1})`);
    assert.equal(r.rnd, fallbackRandao(h, prev), `prevrandao of block ${h}`);
    seen.push(r.rnd);
  }
  checkDistinct(seen);
  // A transaction (DeliverTx on every node) sees what eth_call on its block sees.
  const p = await poke();
  assert.equal(p.rnd, (await readAt(p.height)).rnd);
  assert.equal(p.prevHash, await blockHash(p.height - 1));
});

test('with the ML-DSA-44 vote key registered: prevrandao comes from the certificate in tx[0]', { timeout: 180_000 }, async () => {
  const out = JSON.parse(execFileSync(ZETAPHYD, ['tx', 'pq-vote-key', '--from', 'validator', '--keyring-backend', 'test', '--home', H,
    '--chain-id', CHAIN, '--node', `tcp://127.0.0.1:${PORT + 100}`, '--gas', '600000', '--gas-prices', `1000000000${DENOM}`, '-y', '-o', 'json'], { env }).toString());
  assert.equal(out.code, 0, out.raw_log);
  let reg;
  for (const end = Date.now() + 30_000; !reg && Date.now() < end; await sleep(500)) {
    try { reg = Number((await comet('tx', { hash: Buffer.from(out.txhash, 'hex').toString('base64') })).height); } catch { /* not yet */ }
  }
  assert.ok(reg, 'pq-vote-key is in a block');
  await waitHeight(reg + 6);

  const seen = [];
  for (let h = reg + 2; h <= reg + 6; h++) {
    const cert = await certIn(h);
    assert.ok(cert, `block ${h} carries the certificate for ${h - 1}`);
    assert.equal(cert.height, BigInt(h - 1));
    assert.equal(cert.attestations.length, 2440, 'one validator, one attestation');
    const r = await readAt(h);
    assert.equal(r.rnd, certRandao(h, cert), `prevrandao of block ${h} is sha256 over its certificate`);
    assert.notEqual(r.rnd, fallbackRandao(h, await blockHash(h - 1)));
    seen.push(r.rnd);
  }
  checkDistinct(seen);
  // Transactions in certified blocks.
  const pokes = [await poke(), await poke(), await poke()];
  for (const p of pokes) {
    const cert = await certIn(p.height);
    assert.ok(cert);
    assert.equal(p.rnd, certRandao(p.height, cert));
  }
  checkDistinct(pokes.map((p) => p.rnd));
});

function supplyAt(h) {
  const q = JSON.parse(execFileSync(ZETAPHYD, ['q', 'bank', 'total-supply-of', DENOM, '--height', String(h), '--node', `tcp://127.0.0.1:${PORT + 100}`, '-o', 'json'], { env }).toString());
  return BigInt((q.amount ?? q).amount);
}
async function burnsIn(h) {
  const r = await comet('block_results', { height: String(h) });
  const sum = { fee: 0n, dead: 0n };
  for (const e of r.finalize_block_events ?? []) {
    const kind = { zetaphy_fee_burn: 'fee', zetaphy_dead_burn: 'dead' }[e.type];
    if (!kind) continue;
    const amt = e.attributes.find((a) => a.key === 'amount').value;
    assert.match(amt, new RegExp(`^\\d+${DENOM}$`), 'only ZETAPHY is burned');
    sum[kind] += BigInt(amt.slice(0, -DENOM.length));
  }
  return sum;
}

test('ZETAPHY sent to 0x…dEaD is burned: total supply drops by that amount, dEaD holds 0', { timeout: 120_000 }, async () => {
  const value = parseEther('1234.5');
  const before = await cometHeight();
  const s0 = supplyAt(before);
  const rc = await (await wallet.sendTransaction({ to: DEAD, value, gasLimit: 21_000, nonce: await nonce() })).wait();
  assert.equal(rc.status, 1);
  await waitHeight(rc.blockNumber + 3);
  assert.equal(await provider.getBalance(DEAD), 0n, 'dEaD keeps nothing');
  const afterH = rc.blockNumber + 3;
  let fee = 0n, dead = 0n;
  for (let h = before + 1; h <= afterH; h++) {
    const b = await burnsIn(h);
    fee += b.fee; dead += b.dead;
  }
  assert.equal(dead, value, 'the whole transfer is burned, in the next block');
  assert.equal(await burnsIn(rc.blockNumber + 1).then((b) => b.dead), value);
  const s1 = supplyAt(afterH);
  assert.equal(s0 - s1, value + fee, 'supply drops by the dEaD burn plus the usual 50% fee burn');
  assert.ok(s0 - s1 >= value);
});

// The EIP-2935 history contract (installed by the chain at block 1) answers
// direct calls with CometBFT's block hashes, like BLOCKHASH. Its ring has
// 8191 slots, as the EVM module's (unit test across the wrap:
// fork-tests/evmd/zetaphy_v2_test.go, TestPQHistoryContractRing).
test('v2 on from genesis; the EIP-2935 history contract serves the real block hashes', { timeout: 60_000 }, async () => {
  const gen = JSON.parse(readFileSync(join(H, 'config', 'genesis.json'), 'utf8'));
  assert.deepEqual(gen.app_state.zetaphypq.filter((e) => e.key === '08'), [{ key: '08', value: '0000000000000001' }]);
  assert.equal(String(gen.app_state.evm.params.history_serve_window), '8191');
  const HIST = '0x0000F90827F1C53a10cb7A02335B175320002935';
  const tip = await cometHeight();
  for (let h = Math.max(2, tip - 6); h < tip; h++) {
    const got = await provider.call({ to: HIST, data: zeroPadValue(toBeHex(h), 32), blockTag: tip });
    assert.equal(got, await blockHash(h), `history contract, block ${h}`);
  }
  await assert.rejects(provider.call({ to: HIST, data: zeroPadValue(toBeHex(tip), 32), blockTag: tip }), 'the queried block itself is not served');
});
