#!/usr/bin/env node
// Offline trading (docs/future/offline-trading.md): deploys ZetaphyCheques and ZetaphyOfflineOrders on the ZETAPHY
// TESTNET (src/offlinedeploy.js). Neither contract has an owner or a setting: the deploy key keeps no role.
//
//   node scripts/offline-deploy.js [--router 0x…]
//       deploys what deployments/offline-77390.json does not have yet (a re-run resumes) and writes it after each one;
//       the router defaults to the ZETAPHY Swap router of zetaphy-dex/web/deployments.json
//   node scripts/offline-deploy.js check
//       reads the record back: code at each address, the orders contract bound to the record's router
//
// env: ZETAPHY_RPC (EVM JSON-RPC), KEYFILE (a TESTNET deploy key, 0x… hex; never a key that holds real money),
//      OFFLINE_FILE (default deployments/offline-77390.json). Refuses any chain but 77390.
// The hub (zetaphy-hub/build.mjs) reads the record: the Offline tab then uses these addresses.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { JsonRpcProvider, Wallet, getAddress } from 'ethers';
import { deployOffline, checkOffline } from '../src/offlinedeploy.js';

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const die = (m) => { console.error(m); process.exit(1); };
const FILE = process.env.OFFLINE_FILE || new URL('../deployments/offline-77390.json', import.meta.url).pathname;
const DEX = new URL('../../zetaphy-dex/web/deployments.json', import.meta.url);

const rpc = process.env.ZETAPHY_RPC || die('ZETAPHY_RPC is not set');
const provider = new JsonRpcProvider(rpc, undefined, { staticNetwork: true });
const record = existsSync(FILE) ? JSON.parse(readFileSync(FILE, 'utf8')) : null;
if (Number((await provider.getNetwork()).chainId) !== 77390) die('the RPC is not the ZETAPHY testnet (chain 77390)');

if (args[0] === 'check') {
  if (!record) die(`no ${FILE}: nothing deployed`);
  const r = await checkOffline(provider, record);
  for (const x of r) console.log(`${x.ok ? 'ok ' : 'BAD'} ${x.key} ${x.address}`);
  process.exit(r.every((x) => x.ok) ? 0 : 1);
}

const routerArg = opt('router') ?? (existsSync(DEX) ? JSON.parse(readFileSync(DEX, 'utf8')).contracts?.router : null);
if (!routerArg) die('no router: pass --router 0x…');
const router = getAddress(routerArg);
const key = readFileSync(process.env.KEYFILE || die('KEYFILE is not set'), 'utf8').trim();
const signer = new Wallet(key, provider);
mkdirSync(dirname(FILE), { recursive: true });
const rec = await deployOffline({ signer, router, record, log: console.log, save: (r) => writeFileSync(FILE, `${JSON.stringify(r, null, 2)}\n`) });
console.log(JSON.stringify(rec));
