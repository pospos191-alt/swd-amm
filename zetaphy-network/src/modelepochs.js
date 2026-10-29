// ModelEpochs (contracts/ModelEpochs.sol) from JavaScript: read the
// schedule, select the Neuro model version in force at a block height (the
// same pure function browsers use, zetaphy-neuro/ml/fl/registry.js), and build
// the governance proposal that schedules a new version.

import { readFileSync } from 'node:fs';
import { Interface, Contract, getAddress } from 'ethers';
import { selectVersion, checkSchedule, nextActivation } from '../../zetaphy-neuro/ml/fl/registry.js';

export const REGISTRY_ABI = JSON.parse(readFileSync(new URL('../artifacts/ModelEpochs.json', import.meta.url), 'utf8')).abi;
export const REGISTRY = new Interface(REGISTRY_ABI);
/** EVM address of the gov module: first 20 bytes of sha256("gov") (zetaphy-chain/gov.sh). */
export const GOV_MODULE_EVM = '0x7b5Fe22B5446f7C62Ea27B8BD71CeF94e03f3dF2';

/**
 * Every version, in order, as plain values.
 * @param {{call:(fn:string, args?:any[])=>Promise<any>}} reg  anything with call(fn, args): an ethers Contract wrapper or the test chain
 */
export async function readVersions(reg) {
  const n = Number(await reg.call('count'));
  const out = [];
  for (let i = 0; i < n; i++) {
    const [hash, activation, scheduledAt, uri] = await reg.call('versionByIndex', [i]);
    out.push({ index: i, hash, activation: BigInt(activation), scheduledAt: BigInt(scheduledAt), uri });
  }
  return out;
}

/** The registry read through an ethers provider, at a block tag (default latest). */
export function onChain(address, provider, blockTag = 'latest') {
  const c = new Contract(getAddress(address), REGISTRY_ABI, provider);
  return { call: (fn, args = []) => c[fn](...args, { blockTag }) };
}

/**
 * The version in force at `height`, from a schedule read at any state at or
 * after height-1, plus a cross-check against the contract's own versionAt.
 */
export async function versionForHeight(reg, height) {
  const versions = await readVersions(reg);
  const epoch = BigInt(await reg.call('epochLength'));
  checkSchedule(versions, epoch);
  const js = selectVersion(versions, height);
  const [found, index, hash] = await reg.call('versionAt', [BigInt(height)]);
  if (Boolean(found) !== Boolean(js) || (js && (BigInt(index) !== BigInt(js.index) || hash !== js.hash))) {
    throw new Error('registry and local selection disagree');
  }
  return js;
}

/**
 * A gov proposal (JSON for `zetaphyd tx gov submit-proposal`) whose MsgEVMCall
 * makes the gov module call ModelEpochs.schedule(hash, activation, uri).
 * @param {{registry:string, hash:string, activation:bigint|number, uri:string, govBech32:string, deposit?:string, modelId?:string, headId?:string}} o
 */
export function scheduleProposal(o) {
  const data = REGISTRY.encodeFunctionData('schedule', [o.hash, BigInt(o.activation), o.uri]);
  const title = `Neuro model ${o.modelId ?? ''}${o.headId ? ' + head ' + o.headId : ''} from height ${o.activation}`.replace(/\s+/g, ' ');
  return {
    messages: [{
      '@type': '/zetaphy.pq.v1.MsgEVMCall',
      Sender: o.govBech32,
      To: getAddress(o.registry),
      Value: '0',
      Data: Buffer.from(data.slice(2), 'hex').toString('base64'),
      GasLimit: '300000',
    }],
    metadata: '',
    deposit: o.deposit ?? '1000000000000000000000azetaphy',
    title,
    summary: `ModelEpochs ${getAddress(o.registry)}: schedule manifest sha256 ${o.hash} (${o.uri}) in force from block ${o.activation}. `
      + 'Neuro\'s learned score only; never coin transfers. Recompute the hash from the files before voting (docs/future/federated.md).',
    expedited: false,
  };
}

export { selectVersion, nextActivation };
