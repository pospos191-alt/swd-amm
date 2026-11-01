#!/usr/bin/env node
// Deploys every AI-map contract still missing on the ZETAPHY testnet (src/aideploy.js), each owned by the
// ZetaphyTimelock from the launch state; used by .github/workflows/ai-deploy.yml.
//
//   node scripts/ai-deploy.js [--committee 0x…,0x… --threshold 2] [--poster 0x…] [--host app.sawasdeecoin.com]
//       deploys what deployments/ai-77390.json does not have yet (a re-run resumes) and writes it after each one
//   node scripts/ai-deploy.js check
//       reads every contract's governance back; fails if one is not the timelock
//
// env: ZETAPHY_RPC (EVM JSON-RPC), KEYFILE (the deploy key, 0x… hex), AI_FILE (default deployments/ai-77390.json).
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { JsonRpcProvider, Wallet, getAddress } from 'ethers';
import { deployAi, checkGovernance, fromLaunchState } from '../src/aideploy.js';

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const die = (m) => { console.error(m); process.exit(1); };
const FILE = process.env.AI_FILE || new URL('../deployments/ai-77390.json', import.meta.url).pathname;
const STATE = new URL('../../zetaphy-launch/state/77390.json', import.meta.url);

const rpc = process.env.ZETAPHY_RPC || die('ZETAPHY_RPC is not set');
const provider = new JsonRpcProvider(rpc, undefined, { staticNetwork: true });
const record = existsSync(FILE) ? JSON.parse(readFileSync(FILE, 'utf8')) : null;

if (args[0] === 'check') {
  if (!record) die(`no ${FILE}: nothing deployed`);
  const r = await checkGovernance(provider, record);
  for (const x of r) console.log(`${x.ok ? 'ok ' : 'BAD'} ${x.key} governance ${x.governance}`);
  process.exit(r.every((x) => x.ok) ? 0 : 1);
}

if (Number((await provider.getNetwork()).chainId) !== 77390) die('the RPC is not ZETAPHY (chain 77390)');
const key = readFileSync(process.env.KEYFILE || die('KEYFILE is not set'), 'utf8').trim();
const signer = new Wallet(key, provider);
const st = fromLaunchState(JSON.parse(readFileSync(STATE, 'utf8')));
const list = (s) => (s ? s.split(',').map((a) => getAddress(a.trim())) : undefined);
const o = {};
if (opt('committee')) { o.committee = list(opt('committee')); o.threshold = Number(opt('threshold', '1')); }
if (opt('poster')) o.poster = getAddress(opt('poster'));
if (opt('host')) o.hubHost = opt('host');
const rec = await deployAi({ signer, ...st, record, o, log: console.log, save: (r) => { mkdirSync(dirname(FILE), { recursive: true }); writeFileSync(FILE, `${JSON.stringify(r, null, 2)}\n`); } });
console.log(JSON.stringify(rec));
