// Audit-as-a-Service ordering (docs/future/audit-as-a-service.md): the intake's targets become AuditNetwork
// requests on ZETAPHY (testnet), paid in testnet ZETAPHY. A proxy is two requests (proxy + implementation).
import { keccak256 } from '../../../zetaphy-neuro/src/keccak.js';
import * as aas from '../../../zetaphy-hub/aas-core.js';

const k = keccak256;

/**
 * The transactions to send on ZETAPHY for an intake result: one AuditNetwork.request per target.
 * params: AuditNetwork.getParams() (audit-core decodeParams); pool: the bounty pool per request (wei).
 * Returns { tier, requests: [{ role, native, target, to, data, value, terms }], total } — `to` is AuditNetwork.
 */
export function planOrder({ intake, tier, params, pool, contestDays = null, auditors = null, auditNetwork }) {
  if (!intake?.targets?.length) throw new Error('nothing to order: the intake found no target');
  if (tier === 'fast') throw new Error('the fast tier is the free automated run (the GitHub Action or `zetaphy audit run`): nothing to order on-chain, and no certificate');
  const bad = intake.targets.filter((t) => t.source.origin === 'none' || t.source.match === 'none');
  if (bad.length) throw new Error(`no source bound to ${bad.map((t) => t.native).join(', ')}: auditors must see the code that is deployed (Sourcify, or --repo/--commit that reproduces it)`);
  const terms = aas.orderTerms(params, tier, { pool, contestDays, auditors });
  const requests = intake.targets.map((t) => ({
    role: t.role, native: t.native, target: t.target, chainId: t.chainId, codeHash: t.codeHash, sourceHash: t.sourceHash, uri: t.uri,
    to: auditNetwork, value: terms.value, terms,
    data: aas.requestCalldata(k, { chainId: t.chainId, target: t.target, codeHash: t.codeHash, sourceHash: t.sourceHash }, terms, t.uri),
  }));
  return { tier, requests, total: requests.reduce((s, r) => s + r.value, 0n) };
}

/**
 * How a sponsor on another chain pays. AuditNetwork takes native testnet ZETAPHY (msg.value) on ZETAPHY.
 *   - from ZETAPHY: send the request transaction(s);
 *   - from a chain ZETAPHY's Hyperlane routes reach (Sepolia, Base Sepolia, Arbitrum Sepolia): the routes carry
 *     TOKENS (a lockbox there, a bridged token on ZETAPHY), not native ZETAPHY, so a one-transaction "order from
 *     Sepolia" needs a remote order router (designed in the doc, not deployed). Today: get testnet ZETAPHY on
 *     ZETAPHY (faucet / validator / earn), then send the request from any wallet there;
 *   - from any other chain (including CosmWasm and Solana projects): the same, on ZETAPHY.
 * Testnet ZETAPHY has no value: the "price" is a spam bond and the auditors' bounty in testnet coins.
 */
export function paymentPlan(fromRef) {
  const from = aas.chainOf(fromRef ?? 'zetaphy');
  if (!from) throw new Error(`chain ${fromRef}: not supported`);
  if (from.key === 'zetaphy') return { from: from.key, direct: true, steps: ['send the AuditNetwork.request transaction(s) on ZETAPHY (chain 77390) with the shown value'] };
  const steps = ['get testnet ZETAPHY on ZETAPHY (chain 77390): the hub\'s Earn page (run a node, useful work) or ask in the community faucet thread; it has no value',
    'send the AuditNetwork.request transaction(s) from that ZETAPHY wallet; the sponsor key does not need to be the deployer of the audited contract'];
  if (from.hyperlane) steps.unshift(`${from.name} has a ZETAPHY Hyperlane route, but it carries tokens, not native ZETAPHY: paying in one transaction from ${from.name} needs the remote order router (docs/future/audit-as-a-service.md, "Paying from another chain"), not deployed yet`);
  return { from: from.key, direct: false, hyperlane: !!from.hyperlane, steps };
}
