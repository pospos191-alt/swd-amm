// Offline trading (docs/future/offline-trading.md): deploys ZetaphyCheques and ZetaphyOfflineOrders. Neither has an
// owner or any setting: the deploy key keeps no role, there is nothing to hand over. ZetaphyOfflineOrders takes the
// ZETAPHY Swap router in its constructor (and reads the router's wrapped coin once). A run that stops half way
// resumes: contracts already in the record are skipped.
import { readFileSync } from 'node:fs';
import { ContractFactory, Contract, getAddress } from 'ethers';

const art = (n) => JSON.parse(readFileSync(new URL(`../artifacts/${n}.json`, import.meta.url), 'utf8'));
const ADDR = /^0x[0-9a-fA-F]{40}$/;

export const OFFLINE_STEPS = [
  { key: 'zetaphyCheques', contract: 'ZetaphyCheques', args: () => [] },
  { key: 'offlineOrders', contract: 'ZetaphyOfflineOrders', args: (x) => [x.router] },
];

/**
 * @param signer  an ethers signer (the deploy key)
 * @param router  the ZETAPHY Swap router (zetaphy-dex/web/deployments.json contracts.router)
 * @param record  an earlier, unfinished record (resumes), or null
 * @param save    called with the record after each contract
 */
export async function deployOffline({ signer, router, record = null, save = () => {}, log = () => {} }) {
  if (!ADDR.test(String(router))) throw new Error('router: the ZETAPHY Swap router address is needed');
  const chainId = Number((await signer.provider.getNetwork()).chainId);
  if (record && (record.chainId !== chainId || getAddress(record.router) !== getAddress(router))) throw new Error('the record is for another chain or router');
  const rec = record ?? { chainId, router: getAddress(router), contracts: {} };
  for (const s of OFFLINE_STEPS) {
    if (ADDR.test(String(rec.contracts[s.key] ?? ''))) { log(`${s.key}: ${rec.contracts[s.key]} (already)`); continue; }
    const a = art(s.contract);
    const c = await new ContractFactory(a.abi, a.bytecode, signer).deploy(...s.args({ router: rec.router }));
    await c.waitForDeployment();
    rec.contracts[s.key] = getAddress(await c.getAddress());
    log(`${s.key}: ${rec.contracts[s.key]}`);
    save(rec);
  }
  return rec;
}

/** Reads the record back from the chain: code at each address, the orders contract bound to the record's router. */
export async function checkOffline(provider, rec) {
  const out = [];
  for (const s of OFFLINE_STEPS) {
    const a = rec.contracts?.[s.key];
    const code = ADDR.test(String(a)) ? await provider.getCode(a) : '0x';
    let ok = code !== '0x';
    if (ok && s.key === 'offlineOrders') ok = getAddress(await new Contract(a, art(s.contract).abi, provider).router()) === getAddress(rec.router);
    out.push({ key: s.key, address: a ?? null, ok });
  }
  return out;
}
