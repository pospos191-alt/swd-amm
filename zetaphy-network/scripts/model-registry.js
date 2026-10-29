#!/usr/bin/env node
// ModelRegistry on the ZETAPHY testnet (contracts/ModelRegistry.sol, src/modelregistry.js).
//
//   node scripts/model-registry.js deploy --governance 0x<ZetaphyTimelock> [--guardian 0x<multisig>] [--devnet]
//       deploys with the key in KEYFILE. The deployer key never holds a role: governance is
//       given in the constructor (it must be a contract, i.e. the timelock, unless --devnet).
//       A guardian is named by governance afterwards (through the timelock): see the printed call.
//   node scripts/model-registry.js propose --registry 0x… --release <pack>/release.json --author 0x… [--timelock 0x… --salt text --delay 172800]
//       prints the publish(...) calldata and, with --timelock, the schedule/execute calldata and the
//       operation id for the proposers (multisig or a gov vote). Needs no key and sends nothing.
//   node scripts/model-registry.js status --registry 0x… --kind model --name n --version 1 --status suspended|deprecated|revoked|active [--timelock 0x…]
//       the same for a status change (a guardian can suspend at once: suspend(id, version) from its multisig)
//   node scripts/model-registry.js show --registry 0x… --kind model --name neuro-ml-gbdt [--version N]
//
// env: ZETAPHY_RPC (EVM JSON-RPC, default https://rpc.sawasdeecoin.com), KEYFILE (deploy only: a file holding a testnet key).
// Testnet only. Never pass a key on the command line.
import { readFileSync } from 'node:fs';
import { JsonRpcProvider, Wallet, ContractFactory, Contract, getAddress } from 'ethers';
import { MODEL_REGISTRY, REGISTRY, STATUSES, KINDS, registryIdOf, publishCall, statusCall, timelockOp } from '../src/modelregistry.js';

const CHAIN_ID = 77390n;
const args = process.argv.slice(2);
const cmd = args[0];
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const flag = (n) => args.includes(`--${n}`);
const die = (m) => { console.error(m); process.exit(1); };
const ADDR = /^0x[0-9a-fA-F]{40}$/;
const rpc = process.env.ZETAPHY_RPC ?? 'https://rpc.sawasdeecoin.com';

async function provider() {
  const p = new JsonRpcProvider(rpc);
  const id = (await p.getNetwork()).chainId;
  if (id !== CHAIN_ID && !flag('devnet')) die(`${rpc} is chain ${id}, not the ZETAPHY testnet (${CHAIN_ID}); --devnet for a local chain`);
  return p;
}

function printOp(registry, call) {
  console.log(`${call.fn}(${call.args.map(String).join(', ')})`);
  console.log(`  to:   ${getAddress(registry)}`);
  console.log(`  data: ${call.data}`);
  const tl = opt('timelock');
  if (!tl) { console.log('(governance calls it directly: give --timelock 0x… to get the timelock operation)'); return; }
  if (!ADDR.test(tl)) die('--timelock must be a 0x address');
  const op = timelockOp(registry, call.data, { salt: opt('salt'), delay: Number(opt('delay', 172800)) });
  console.log(`timelock ${getAddress(tl)}: operation ${op.id} (salt ${op.salt}, delay ${op.delay} s)`);
  console.log(`  schedule data (a proposer sends it to the timelock): ${op.schedule}`);
  console.log(`  execute data (anyone, after the delay):             ${op.execute}`);
}

if (cmd === 'deploy') {
  const gov = opt('governance');
  if (!ADDR.test(String(gov))) die('--governance 0x<ZetaphyTimelock> is required (the deployer key never holds a role)');
  if (!process.env.KEYFILE) die('KEYFILE: a file with this testnet deployer key');
  const p = await provider();
  if ((await p.getCode(gov)) === '0x' && !flag('devnet')) die('--governance is not a contract: use the ZetaphyTimelock (or --devnet for a local test)');
  const signer = new Wallet(readFileSync(process.env.KEYFILE, 'utf8').trim(), p);
  const k = await new ContractFactory(MODEL_REGISTRY.abi, MODEL_REGISTRY.bytecode, signer).deploy(gov);
  await k.waitForDeployment();
  const address = await k.getAddress();
  console.log(`ModelRegistry ${address}, governance ${getAddress(gov)}`);
  const g = opt('guardian');
  if (g) {
    if (!ADDR.test(g)) die('--guardian must be a 0x address');
    printOp(address, { fn: 'setGuardian', args: [g, true], data: REGISTRY.encodeFunctionData('setGuardian', [g, true]) });
  }
  console.log(JSON.stringify({ modelRegistry: address, governance: getAddress(gov) }));
} else if (cmd === 'propose') {
  const registry = opt('registry');
  const author = opt('author');
  if (!ADDR.test(String(registry)) || !ADDR.test(String(author))) die('usage: propose --registry 0x… --release release.json --author 0x…');
  const rel = JSON.parse(readFileSync(opt('release'), 'utf8'));
  printOp(registry, publishCall(rel, author));
} else if (cmd === 'status') {
  const registry = opt('registry');
  if (!ADDR.test(String(registry))) die('--registry 0x…');
  printOp(registry, statusCall(opt('kind', 'model'), opt('name'), Number(opt('version')), opt('status')));
} else if (cmd === 'show') {
  const registry = opt('registry');
  if (!ADDR.test(String(registry))) die('--registry 0x…');
  const k = new Contract(registry, MODEL_REGISTRY.abi, await provider());
  const id = registryIdOf(opt('kind', 'model'), opt('name'));
  const version = opt('version') ? Number(opt('version')) : Number(await k.latestVersion(id));
  const r = await k.release(id, version);
  console.log(JSON.stringify({ id, version, kind: KINDS[Number(r.kind)], status: STATUSES[Number(r.status)], manifestHash: r.manifestHash, chunkRoot: r.chunkRoot,
    size: Number(r.size), chunkSize: Number(r.chunkSize), author: r.author, license: r.license, publishedAt: Number(r.publishedAt), updatedAt: Number(r.updatedAt) }, null, 2));
} else {
  die('usage: model-registry.js deploy | propose | status | show (see the top of this file)');
}
