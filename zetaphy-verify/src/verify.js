// Verifies one address on every configured explorer.
// It only submits when the on-chain code matches a contract in build-info
// (by code fingerprint), so it never sends the wrong source anywhere.

import { codeFingerprint } from '../../zetaphy-neuro/src/fingerprint.js';

/**
 * Constructor arguments = recorded creation code minus the compiled creation
 * code. Returns null when the prefix does not match (different build).
 */
export function constructorArgsFrom(creationBytecode, compiledCreation) {
  const rec = creationBytecode.replace(/^0x/, '').toLowerCase();
  const own = compiledCreation.replace(/^0x/, '').toLowerCase();
  if (!own || !rec.startsWith(own)) return null;
  return rec.slice(own.length);
}

/**
 * @param {object} p
 * @param {number} p.chainId
 * @param {string} p.address
 * @param {string} [p.txHash]  creation transaction, when known (from the factory's event)
 * @param {{call: Function}} p.rpc
 * @param {{byFingerprint: Function}} p.builds
 * @param {Array} p.explorers  from explorers.js (nulls are skipped)
 * @returns {Promise<{address, status, contract?, results?, detail?}>}
 */
export async function verifyAddress({ chainId, address, txHash, rpc, builds, explorers }) {
  const addr = address.toLowerCase();
  const code = await rpc.call('eth_getCode', [addr, 'latest']);
  if (!code || code === '0x') return { address: addr, status: 'skipped', detail: 'no code at this address' };
  const contract = builds.byFingerprint(await codeFingerprint(code));
  if (!contract) return { address: addr, status: 'skipped', detail: 'code does not match any contract in build-info' };

  const results = {};
  for (const ex of explorers.filter(Boolean)) {
    try {
      if (await ex.isVerified(chainId, addr)) { results[ex.name] = { ok: true, status: 'already-verified' }; continue; }
      let constructorArgs;
      if (ex.creation) {
        const c = await ex.creation(chainId, addr);
        if (c?.creationBytecode) {
          constructorArgs = constructorArgsFrom(c.creationBytecode, contract.creation);
          if (constructorArgs == null) { results[ex.name] = { ok: false, status: 'failed', detail: 'creation code does not start with the compiled code' }; continue; }
        }
      }
      results[ex.name] = await ex.wait(await ex.submit({ chainId, address: addr, contract, txHash, constructorArgs }));
    } catch (e) {
      results[ex.name] = e.planRequired
        ? { ok: false, status: 'plan-required', detail: e.message }
        : { ok: false, status: 'error', detail: e.message };
    }
  }
  const failed = Object.values(results).some((r) => !r.ok && r.status !== 'plan-required');
  return { address: addr, status: failed ? 'failed' : 'done', contract: contract.fqn, results };
}
