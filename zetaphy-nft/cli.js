#!/usr/bin/env node
// zetaphy-nft: deploys the NFT factory and marketplace to a ZETAPHY node and
// writes the deployments JSON the web app reads; governance calls; key file.
//
//   node cli.js key new  [--key-file F]           make a deployer key (prints the address only)
//   node cli.js key address [--key-file F]
//   node cli.js deploy --rpc URL [--key-file F] [--governance 0x…] [--fee-bps 100]
//        [--fee-recipient 0x…] [--registry 0x…] [--public-rpc URL] [--out web/deployments.json]
//   node cli.js info [--deployments web/deployments.json] [--rpc URL]
//   node cli.js gov set-fee <bps> <recipient> | set-registry <0x…|0> | set-governance <0x…>
//        | protect-code [--registry 0x…]   [--deployments F] [--rpc URL] [--key-file F]
//
// Neuro and the factory's shared code: every factory collection of a kind has the
// same runtime code, so a flag on its code key would hit all of them. The marketplace
// judges factory collections by their address key only (NFTFactory.isCollection), but
// wallets and explorers read the code key too: ThreatRegistry governance should
// protect the two code keys (setProtected). `deploy` does it itself when the deployer
// key is the registry's governance, and otherwise prints the step; `gov protect-code`
// runs it with the governance key.
//
// Keys: see src/keys.js (a file, a keystore with ZETAPHY_PASSPHRASE, or ZETAPHY_PRIVATE_KEY).
// Testnet only: the contracts are not audited.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { JsonRpcProvider, ContractFactory, Contract, NonceManager, isAddress, getAddress, keccak256, ZeroAddress, AbiCoder } from 'ethers';
import { loadKey, newKey } from './src/keys.js';

const EVM_CHAIN_ID = 77390n;
const art = (n) => JSON.parse(readFileSync(new URL(`./artifacts/${n}.json`, import.meta.url), 'utf8'));
const DEFAULT_OUT = new URL('./web/deployments.json', import.meta.url).pathname;
const REGISTRY_ABI = ['function governance() view returns (address)', 'function setProtected(bytes32[] keys, bool on)', 'function protectedKey(bytes32) view returns (bool)'];

/** The runtime code hashes every factory collection has, and their ThreatRegistry code keys. */
function collectionCode() {
  const hashes = { erc721: keccak256(art('ZetaphyERC721').deployedBytecode), erc1155: keccak256(art('ZetaphyERC1155').deployedBytecode) };
  // ThreatRegistry.codeKey(h) = keccak256(abi.encode("zetaphy.threat.code", h))
  const key = (h) => keccak256(AbiCoder.defaultAbiCoder().encode(['string', 'bytes32'], ['zetaphy.threat.code', h]));
  return { hashes, keys: { erc721: key(hashes.erc721), erc1155: key(hashes.erc1155) } };
}

const protectStep = (keys, registry) => [
  'NEXT STEP (ThreatRegistry governance): protect the factory collections\' shared code keys, so one code flag',
  'cannot mark every factory collection in wallets and explorers (the marketplace already judges them by address only):',
  `  ThreatRegistry${registry ? ` ${registry}` : ''}.setProtected([${keys.erc721}, ${keys.erc1155}], true)`,
  '  e.g. node cli.js gov protect-code --key-file <the registry governance key>',
].join('\n');

/** Protects the code keys if `wallet` is the registry's governance; else prints the step. */
async function protectCodeKeys(registry, signer, address) {
  const { keys } = collectionCode();
  if (!registry || registry === ZeroAddress) { console.log(protectStep(keys, null).replace('NEXT STEP', 'WHEN A REGISTRY IS SET')); return false; }
  const reg = new Contract(registry, REGISTRY_ABI, signer);
  const gov = await reg.governance().catch(() => null);
  if (!gov || gov.toLowerCase() !== address.toLowerCase()) {
    console.log(`the deployer is not this ThreatRegistry's governance (${gov ?? 'unknown'}).`);
    console.log(protectStep(keys, registry));
    return false;
  }
  const r = await (await reg.setProtected([keys.erc721, keys.erc1155], true)).wait();
  console.log(`protected the factory collections' code keys in ThreatRegistry ${registry} (block ${r.blockNumber}): ${keys.erc721}, ${keys.erc1155}`);
  return true;
}

function parseArgs(argv) {
  const pos = [];
  const opt = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      if (['any-chain', 'help'].includes(k)) opt[k] = true;
      else { if (i + 1 >= argv.length) throw new Error(`${a} needs a value`); opt[k] = argv[++i]; }
    } else pos.push(a);
  }
  return { pos, opt };
}
const addr = (v, what) => { if (!isAddress(v)) throw new Error(`${what}: not an address: ${v}`); return getAddress(v); };

async function connect(opt, rpcFallback) {
  const rpc = opt.rpc ?? rpcFallback;
  if (!rpc) throw new Error('--rpc URL is required');
  const probe = new JsonRpcProvider(rpc, 1n, { staticNetwork: true, batchMaxCount: 1 });
  const id = BigInt(await probe.send('eth_chainId', []));
  probe.destroy();
  if (id !== EVM_CHAIN_ID && !opt['any-chain']) throw new Error(`the node's EVM chain id is ${id}, not ${EVM_CHAIN_ID} (ZETAPHY); pass --any-chain to deploy anyway`);
  const provider = new JsonRpcProvider(rpc, id, { staticNetwork: true, batchMaxCount: 1 });
  return { provider, rpc, chainId: id };
}

async function deploy(opt) {
  const { provider, rpc, chainId } = await connect(opt);
  const { wallet, source } = loadKey(opt['key-file']);
  // The node may answer the pending nonce late right after a receipt: count nonces here.
  const signer = new NonceManager(wallet.connect(provider));
  const governance = opt.governance ? addr(opt.governance, '--governance') : wallet.address;
  const feeRecipient = opt['fee-recipient'] ? addr(opt['fee-recipient'], '--fee-recipient') : governance;
  const feeBps = Number(opt['fee-bps'] ?? 100);
  if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > 500) throw new Error('--fee-bps: 0 to 500 (5%)');
  const registry = opt.registry && opt.registry !== '0' ? addr(opt.registry, '--registry') : ZeroAddress;
  const balance = await provider.getBalance(wallet.address);
  console.log(`deployer ${wallet.address} (key: ${source}), balance ${balance} azetaphy`);
  if (balance === 0n) throw new Error('the deployer has no ZETAPHY: fund it first (testnet faucet)');

  const F = art('NFTFactory');
  const factory = await new ContractFactory(F.abi, F.bytecode, signer).deploy();
  const fr = await factory.deploymentTransaction().wait();
  console.log(`NFTFactory deployed at ${await factory.getAddress()} (block ${fr.blockNumber})`);
  const M = art('NFTMarketplace');
  const market = await new ContractFactory(M.abi, M.bytecode, signer).deploy(governance, feeRecipient, feeBps, registry, await factory.getAddress());
  await market.deploymentTransaction().wait();
  console.log(`NFTMarketplace deployed at ${await market.getAddress()} (fee ${feeBps / 100}% to ${feeRecipient}, governance ${governance}, ThreatRegistry ${registry === ZeroAddress ? 'off' : registry}, factory collections judged by address key)`);
  const code = collectionCode();
  const protectedNow = await protectCodeKeys(registry, signer, wallet.address);

  const out = {
    network: chainId === EVM_CHAIN_ID ? 'zetaphy-testnet' : `evm-${chainId}`,
    chainId: Number(chainId),
    rpc: opt['public-rpc'] ?? rpc,
    factory: await factory.getAddress(),
    marketplace: await market.getAddress(),
    threatRegistry: registry === ZeroAddress ? '' : registry,
    governance, feeRecipient, feeBps,
    deployBlock: fr.blockNumber,
    deployedAt: new Date().toISOString(),
    // Every factory collection of a kind has this runtime code: ThreatRegistry governance
    // protects these code keys (setProtected) so one code flag cannot hit them all.
    collectionCodeHashes: code.hashes,
    collectionCodeKeys: code.keys,
    codeKeysProtected: protectedNow,
  };
  const file = resolve(opt.out ?? DEFAULT_OUT);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(out, null, 2) + '\n');
  console.log(`wrote ${file}`);
  return out;
}

const readDeployments = (opt) => {
  const f = resolve(opt.deployments ?? DEFAULT_OUT);
  if (!existsSync(f)) throw new Error(`${f} not found: deploy first or pass --deployments`);
  return JSON.parse(readFileSync(f, 'utf8'));
};

async function info(opt) {
  const d = readDeployments(opt);
  const { provider } = await connect(opt, d.rpc);
  const m = new Contract(d.marketplace, art('NFTMarketplace').abi, provider);
  const f = new Contract(d.factory, art('NFTFactory').abi, provider);
  console.log(JSON.stringify({ ...d, now: { governance: await m.governance(), feeBps: Number(await m.feeBps()), feeRecipient: await m.feeRecipient(),
    threatRegistry: await m.threatRegistry(), listings: Number(await m.listingCount()), offers: Number(await m.offerCount()), collections: Number(await f.collectionCount()) } }, null, 2));
}

async function gov(pos, opt) {
  const d = readDeployments(opt);
  const { provider } = await connect(opt, d.rpc);
  const { wallet } = loadKey(opt['key-file']);
  const m = new Contract(d.marketplace, art('NFTMarketplace').abi, new NonceManager(wallet.connect(provider)));
  const [what, a, b] = pos;
  let tx;
  if (what === 'set-fee') tx = await m.setFee(Number(a), addr(b ?? ZeroAddress, 'recipient'));
  else if (what === 'set-registry') tx = await m.setThreatRegistry(a === '0' ? ZeroAddress : addr(a, 'registry'));
  else if (what === 'set-governance') tx = await m.setGovernance(addr(a, 'governance'));
  else if (what === 'protect-code') {
    const registry = opt.registry ? addr(opt.registry, '--registry') : await m.threatRegistry();
    if (registry === ZeroAddress) throw new Error('protect-code: the marketplace has no ThreatRegistry: pass --registry 0x…');
    if (!(await protectCodeKeys(registry, m.runner, wallet.address))) process.exitCode = 1;
    return;
  } else throw new Error('gov: set-fee <bps> <recipient> | set-registry <0x…|0> | set-governance <0x…> | protect-code [--registry 0x…]');
  const r = await tx.wait();
  console.log(`${what} done in block ${r.blockNumber} (tx ${r.hash})`);
  if (what === 'set-registry' && a !== '0') await protectCodeKeys(addr(a, 'registry'), m.runner, wallet.address);
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { pos, opt } = parseArgs(rest);
  if (!cmd || opt.help || cmd === 'help' || cmd === '--help' || cmd === '-h') { console.log(readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1).filter((l, i, all) => all.slice(0, i + 1).every((x) => x.startsWith('//'))).map((l) => l.slice(3)).join('\n')); return; }
  if (cmd === 'key' && pos[0] === 'new') { const k = newKey(opt['key-file']); console.log(`new key ${k.file}${k.encrypted ? ' (encrypted)' : ''}\naddress ${k.address}\nfund this address with testnet ZETAPHY before deploying`); return; }
  if (cmd === 'key' && pos[0] === 'address') { console.log(loadKey(opt['key-file']).wallet.address); return; }
  if (cmd === 'deploy') return void await deploy(opt);
  if (cmd === 'info') return info(opt);
  if (cmd === 'gov') return gov(pos, opt);
  throw new Error(`unknown command ${cmd} (try --help)`);
}

main().catch((e) => { console.error(`error: ${e.shortMessage ?? e.message}`); process.exit(1); });
