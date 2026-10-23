#!/usr/bin/env node
// ZETAPHY Saphan, EVM route, Sepolia side: the HyperlaneLockBox (lock Sepolia ETH,
// dispatch to the HyperlaneLane on ZETAPHY). Used by the bridge-testnet workflow.
//
//   node scripts/bridge-sepolia.js check
//       read only: the Sepolia Mailbox, which hook to use, the deployer's balance and nonce,
//       and the address the lockbox will get (deployer + nonce). Prints JSON on the last line.
//   node scripts/bridge-sepolia.js deploy --recipient 0x<HyperlaneLane> --expect 0x<address from check> --hook 0x<hook|0x0>
//       deploys the lockbox; refuses if the deployer's nonce moved (the address would differ).
//
// env: SEPOLIA_RPC (comma-separated, first that answers chain 11155111), KEYFILE (deploy only:
// the deployer key file; never printed), DEPLOYER (check: the deployer address).
import { readFileSync } from 'node:fs';
import { JsonRpcProvider, Wallet, Contract, ContractFactory, AbiCoder, getCreateAddress, getAddress, formatEther, zeroPadValue } from 'ethers';

export const SEPOLIA = {
  chainId: 11155111n,
  // hyperlane-registry chains/sepolia/addresses.yaml
  mailbox: '0xfFAEF09B3cd11D9b20d1a19bECca54EEC2884766',
  merkleTreeHook: '0x4917a9746A7B6E0A57159cCb7F5a6744247f2d0d',
};
export const ZETAPHY_DOMAIN = 77390;
const MERKLE_TREE_HOOK_TYPE = 3; // IPostDispatchHook.Types.MERKLE_TREE

const MAILBOX = [
  'function localDomain() view returns (uint32)', 'function defaultHook() view returns (address)', 'function requiredHook() view returns (address)',
  'function quoteDispatch(uint32,bytes32,bytes) view returns (uint256)', 'function quoteDispatch(uint32,bytes32,bytes,bytes,address) view returns (uint256)',
];
const HOOK = ['function hookType() view returns (uint8)', 'function mailbox() view returns (address)'];
const art = JSON.parse(readFileSync(new URL('../artifacts/HyperlaneLockBox.json', import.meta.url), 'utf8'));

async function provider() {
  for (const url of String(process.env.SEPOLIA_RPC ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
    try {
      const p = new JsonRpcProvider(url, SEPOLIA.chainId, { staticNetwork: true });
      if (BigInt(await p.send('eth_chainId', [])) === SEPOLIA.chainId) return p;
    } catch { /* next */ }
  }
  throw new Error('no SEPOLIA_RPC answered chain 11155111');
}

/** A body the size the lockbox sends (192 bytes), for quotes. */
const sampleBody = (who) => AbiCoder.defaultAbiCoder().encode(['uint256', 'address', 'uint256', 'address', 'address', 'uint256'], [SEPOLIA.chainId, who, 0, who, who, 1n]);

/** Runs one read, naming it in the error (a bare revert says nothing about which call). */
async function step(label, fn) {
  try { return await fn(); } catch (e) { throw new Error(`${label}: ${e.shortMessage ?? e.message}`); }
}

export async function check(p, deployer) {
  const mb = new Contract(SEPOLIA.mailbox, MAILBOX, p);
  const domain = Number(await step('Mailbox.localDomain', () => mb.localDomain()));
  if (domain !== Number(SEPOLIA.chainId)) throw new Error(`Sepolia Mailbox localDomain ${domain}`);
  const mh = new Contract(SEPOLIA.merkleTreeHook, HOOK, p);
  if (Number(await step('MerkleTreeHook.hookType', () => mh.hookType())) !== MERKLE_TREE_HOOK_TYPE) throw new Error('the Sepolia MerkleTreeHook is not a merkle tree hook');
  if (getAddress(await step('MerkleTreeHook.mailbox', () => mh.mailbox())) !== getAddress(SEPOLIA.mailbox)) throw new Error('the Sepolia MerkleTreeHook belongs to another Mailbox');
  const to = zeroPadValue(deployer, 32), body = sampleBody(deployer);
  // The default hook pays Hyperlane's gas paymaster, which may not quote ZETAPHY (a new domain): then the
  // lockbox uses the MerkleTreeHook alone (the validators sign its root; our relayer delivers unpaid).
  let hook = '0x0000000000000000000000000000000000000000', defaultQuote = null, why = '';
  try { defaultQuote = await mb['quoteDispatch(uint32,bytes32,bytes)'](ZETAPHY_DOMAIN, to, body); } catch (e) { why = e.shortMessage ?? e.message; hook = SEPOLIA.merkleTreeHook; }
  const fee = hook === SEPOLIA.merkleTreeHook
    ? await step('Mailbox.quoteDispatch with the MerkleTreeHook', () => mb['quoteDispatch(uint32,bytes32,bytes,bytes,address)'](ZETAPHY_DOMAIN, to, body, '0x', hook))
    : defaultQuote;
  const nonce = await p.getTransactionCount(deployer, 'latest');
  const pending = await p.getTransactionCount(deployer, 'pending');
  const balance = await p.getBalance(deployer);
  return {
    deployer, balance: formatEther(balance), nonce, pendingTxs: pending - nonce, lockbox: getCreateAddress({ from: deployer, nonce }),
    defaultHook: await step('Mailbox.defaultHook', () => mb.defaultHook()), requiredHook: await step('Mailbox.requiredHook', () => mb.requiredHook()), defaultHookQuotesZetaphy: defaultQuote != null, defaultHookError: why.slice(0, 160),
    hook, feePerLock: formatEther(fee),
  };
}

export async function deploy(p, wallet, { recipient, expect, hook }) {
  const me = await wallet.getAddress();
  const nonce = await p.getTransactionCount(me, 'pending');
  const at = getCreateAddress({ from: me, nonce });
  if (getAddress(at) !== getAddress(expect)) throw new Error(`the deployer's Sepolia nonce moved: the lockbox would be ${at}, not ${expect} (the ZETAPHY side points at ${expect}); nothing deployed`);
  const f = new ContractFactory(art.abi, art.bytecode, wallet.connect(p));
  const k = await f.deploy(SEPOLIA.mailbox, ZETAPHY_DOMAIN, zeroPadValue(recipient, 32), hook);
  await k.waitForDeployment();
  const addr = await k.getAddress();
  if (getAddress(addr) !== getAddress(expect)) throw new Error(`deployed at ${addr}, expected ${expect}`);
  const c = new Contract(addr, art.abi, p);
  const ok = getAddress(await c.mailbox()) === getAddress(SEPOLIA.mailbox) && Number(await c.destinationDomain()) === ZETAPHY_DOMAIN
    && (await c.recipient()).toLowerCase() === zeroPadValue(recipient, 32).toLowerCase() && getAddress(await c.hook()) === getAddress(hook);
  if (!ok) throw new Error('the deployed lockbox does not read back as configured');
  return { lockbox: addr, tx: k.deploymentTransaction()?.hash, fee: formatEther(await c.quoteLock(me, 1n)) };
}

function args(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) o[argv[i].slice(2)] = argv[++i];
  return o;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [cmd, ...rest] = process.argv.slice(2);
  const o = args(rest);
  (async () => {
    const p = await provider();
    if (cmd === 'check') {
      const deployer = getAddress(String(process.env.DEPLOYER ?? ''));
      console.log(JSON.stringify(await check(p, deployer)));
    } else if (cmd === 'deploy') {
      for (const k of ['recipient', 'expect', 'hook']) if (!/^0x[0-9a-fA-F]{40}$/.test(String(o[k] ?? ''))) throw new Error(`--${k} 0x… is needed`);
      const wallet = new Wallet(readFileSync(String(process.env.KEYFILE), 'utf8').trim());
      console.log(JSON.stringify(await deploy(p, wallet, o)));
    } else throw new Error('usage: bridge-sepolia.js check | deploy --recipient 0x… --expect 0x… --hook 0x…');
    p.destroy();
  })().catch((e) => { console.error(`error: ${e.shortMessage ?? e.message}`); process.exit(1); });
}
