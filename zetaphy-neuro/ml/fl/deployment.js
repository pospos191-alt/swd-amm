// Neuro federated learning: where the round contract is (ml/fl/deployment.json).
//
// The browser panel (web/fl-panel.js), the aggregator (zetaphy-network/scripts/fl-aggregate.js)
// and the weekly workflow read this one file. `rounds: null` means FederatedRounds is not
// deployed yet: the panel then says so and sends nothing. `zetaphy fl deploy --out` writes it
// (zetaphy-network/src/flcli.js); a pull request commits it. Public data only.

export const DEPLOYMENT_FORMAT = 'neuro-fl-deployment/1';
const ADDR = /^0x[0-9a-fA-F]{40}$/;

/**
 * Checks a deployment record; returns a clean copy with `deployed` (bool). Throws on a malformed file.
 * @param {object} d  parsed deployment.json
 */
export function checkDeployment(d) {
  if (!d || d.format !== DEPLOYMENT_FORMAT) throw new Error('not a Neuro FL deployment record');
  if (!Number.isSafeInteger(d.chainId) || d.chainId <= 0) throw new Error('deployment: chainId');
  if (typeof d.rpc !== 'string' || !/^https?:\/\/[^\s]{3,200}$/.test(d.rpc)) throw new Error('deployment: rpc must be an http(s) URL');
  for (const k of ['rounds', 'governance', 'threatRegistry']) if (d[k] != null && !ADDR.test(d[k])) throw new Error(`deployment: ${k} must be a 0x address or null`);
  if (d.deployBlock != null && !(Number.isSafeInteger(d.deployBlock) && d.deployBlock >= 0)) throw new Error('deployment: deployBlock');
  return {
    format: d.format, network: String(d.network ?? ''), chainId: d.chainId, rpc: d.rpc, rounds: d.rounds ?? null, deployBlock: d.deployBlock ?? null,
    governance: d.governance ?? null, threatRegistry: d.threatRegistry ?? null, deployed: ADDR.test(String(d.rounds ?? '')),
  };
}
