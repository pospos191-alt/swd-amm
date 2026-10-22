// zetaphy security … (cli.js hands these over): the chain's security core
// (zetaphy-chain zetaphy_security.go; docs/SECURITY-CORE.md).
//   status                      Q-day, threat gate, IBC hold settings
//   migration [<address>]       where an account stands for Q-day (default: this machine's ECDSA key)
//   qday-commit                 Q-day recovery step 1 for this machine's ECDSA key (never used on
//                               chain) -> this machine's pq native (ML-DSA-44) account
//   qday-reveal                 step 2, at least the reveal delay later
//   consent <target 0x…> <seconds> [--as <owner>]   go ahead past the threat gate for calls to target
//   ibc-holds                   inbound IBC transfers that wait
//   ibc-hold-cancel <id>        the guardian (this pq native account) returns one to its sender
// The ECDSA key only signs the migration text locally (personal_sign); it never sends a
// transaction, so its public key stays off the chain until the reveal.

import { SigningKey, hashMessage, hexlify } from 'ethers';
import {
  pqClient, pqAddress, normalizeAddress, toChecksumHex, addressBytes, qdayRevealText, qdaySalt, qdayCommitment, MAX_CONSENT_SECONDS,
} from './pqtx.js';

const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

/** The migration of `ecdsaWallet`'s account to `controller` (an ethers Wallet; nothing is sent). */
export async function qdayMigration({ ecdsaWallet, controller, chainId }) {
  const text = qdayRevealText({ chainId, owner: ecdsaWallet.address, controller });
  const signature = await ecdsaWallet.signMessage(text); // local only
  const publicKey = SigningKey.computePublicKey(SigningKey.recoverPublicKey(hashMessage(text), signature), true);
  const salt = qdaySalt(signature);
  return { text, signature, publicKey, salt, commitment: qdayCommitment({ chainId, publicKey, controller, salt }) };
}

export async function securityCommand({ cmd, rest, opt, env, write, s, connectRpc, loadOrCreatePq, loadOrCreateKey }) {
  const USAGE = {
    status: ['', 0, 0], migration: ['[<0x… or zetaphy1…>]', 0, 1], 'qday-commit': ['', 0, 0], 'qday-reveal': ['', 0, 0],
    consent: ['<target 0x…> <seconds, 0 withdraws, at most 86400> [--as <owner>]', 2, 2], 'ibc-holds': ['', 0, 0], 'ibc-hold-cancel': ['<id>', 1, 1],
  };
  if (!Object.hasOwn(USAGE, cmd ?? '')) throw new Error(`usage: zetaphy security [${Object.keys(USAGE).join(' | ')}] …`);
  if (rest.length < USAGE[cmd][1] || rest.length > USAGE[cmd][2]) throw new Error(`usage: zetaphy security ${cmd} ${USAGE[cmd][0]}`);
  const provider = await connectRpc(s);
  const chainId = env.ZETAPHY_CHAIN_ID ?? undefined;
  const client = pqClient((m, p) => provider.send(m, p), chainId ? { chainId } : {});
  const pqSigner = () => {
    const pq = loadOrCreatePq();
    return { me: pqAddress(pq.publicKeyBytes), signer: { publicKey: pq.publicKeyBytes, sign: pq.signBytes } };
  };
  const landed = (r) => write(`tx hash: ${r.txHash} (accepted by the node; it lands in a block within seconds)`);
  const st = await client.securityStatus();

  if (cmd === 'status') {
    write(`security core: ${st.securityCoreFrom ? `on from block ${st.securityCoreFrom}` : 'not on this chain'} (precompile ${st.securityPrecompile})`);
    write(st.qdayHeight ? `Q-day: block ${st.qdayHeight}${st.qdayActive ? ' (passed: ECDSA-signed transactions are refused)' : ` (now ${st.latestHeight})`}, reveal delay ${st.revealDelay} blocks`
      : 'Q-day: not scheduled');
    write(st.threatGateEnabled ? `threat gate: on, registry ${st.threatRegistry} (consent lasts at most ${st.maxConsentSeconds} s)` : 'threat gate: off');
    write(`IBC hold: ${st.ibcHoldRules.length ? st.ibcHoldRules.map((r) => `${r.denom} from ${r.minAmount}${r.supplyBps ? ` or ${r.supplyBps} bps of supply` : ''}`).join('; ') : 'no rules (off)'}, delay ${st.ibcHoldDelaySeconds} s, guardian ${st.ibcHoldGuardian || 'none (governance only)'}`);
    return 0;
  }
  if (cmd === 'migration') {
    const who = rest[0] != null ? normalizeAddress(rest[0]) : normalizeAddress(loadOrCreateKey().wallet.address);
    const m = await client.migration(who.hex);
    write(`account ${m.address} (${m.hex})`);
    if (m.postQuantum) write('ML-DSA-44 account: post-quantum already, nothing to do');
    else if (m.migrated) write(`migrated: its ML-DSA-44 controller is ${m.controller}`);
    else if (m.pendingController) write(`migration pending: to ${m.pendingController}, final at block ${m.pendingFinalHeight}`);
    else if (!m.exposed) write(`not migrated; its public key was never used on chain, so after Q-day it can still migrate by commit–reveal`);
    else write('not migrated and its public key has been used on chain: migrate BEFORE Q-day (zetaphy pq native lock-ecdsa, or "prepare for Q-day" in the wallet)');
    return 0;
  }
  if (cmd === 'qday-commit' || cmd === 'qday-reveal') {
    const { me, signer } = pqSigner();
    const { wallet } = loadOrCreateKey(); // never printed
    const mig = await qdayMigration({ ecdsaWallet: wallet, controller: me.hex, chainId: client.chainId ?? chainId });
    const owner = normalizeAddress(wallet.address);
    const m = await client.migration(owner.hex);
    if (m.migrated) throw new Error(`${owner.hex} is migrated already (controller ${m.controller})`);
    if (m.exposed && !m.pendingController) throw new Error(`${owner.hex} has used its public key on chain, so commit–reveal cannot protect it; before Q-day use "zetaphy pq native lock-ecdsa"`);
    const c = await client.commitmentHeight(mig.commitment);
    if (cmd === 'qday-commit') {
      if (c.found) { write(`already committed in block ${c.height}; reveal from block ${Number(c.height) + Number(st.revealDelay)} with: zetaphy security qday-reveal`); return 0; }
      const r = await client.qdayCommit({ ...signer, commitment: mig.commitment });
      write(`committed ${hexlify(mig.commitment)} for ${owner.hex} -> ${me.bech32} (the ECDSA key sent nothing; nothing about it is on chain yet)`);
      write(`reveal after ${st.revealDelay} blocks${st.qdayActive ? '' : ' and once Q-day has passed'}: zetaphy security qday-reveal`);
      landed(r);
      return 0;
    }
    if (!c.found) throw new Error('no commitment for this migration yet: run "zetaphy security qday-commit" first');
    if (!st.qdayActive) throw new Error(`the reveal opens at Q-day${st.qdayHeight ? ` (block ${st.qdayHeight})` : ' (not scheduled)'}`);
    const ready = Number(c.height) + Number(st.revealDelay);
    if (Number(st.latestHeight) + 1 < ready) throw new Error(`too early: reveal from block ${ready} (now ${st.latestHeight})`);
    const r = await client.qdayReveal({ ...signer, owner: owner.hex, controller: me.hex, salt: mig.salt, signature: mig.signature });
    write(`revealed: ${owner.hex} moves to ${me.bech32} after ${st.revealDelay} more blocks (an older commitment for it could still replace this one meanwhile)`);
    landed(r);
    return 0;
  }
  if (cmd === 'consent') {
    const [target, secs] = rest;
    if (!ADDR_RE.test(String(target))) throw new Error('target must be a 0x address');
    if (!/^\d+$/.test(String(secs)) || Number(secs) > MAX_CONSENT_SECONDS) throw new Error(`seconds: 0 to ${MAX_CONSENT_SECONDS} (0 withdraws)`);
    const { me, signer } = pqSigner();
    const asOwner = opt.as != null && opt.as !== true ? normalizeAddress(String(opt.as)).bech32 : undefined;
    const r = await client.consent({ ...signer, target, seconds: BigInt(secs), asOwner });
    const who = asOwner ?? me.bech32;
    write(Number(secs) ? `consent: ${who} may call ${toChecksumHex(addressBytes(target))} for ${secs} s even though the threat gate would refuse it. The flag is about real code facts: be sure.`
      : `consent withdrawn for ${target}`);
    landed(r);
    return 0;
  }
  if (cmd === 'ibc-holds') {
    const holds = await client.ibcHolds();
    if (!holds.length) write('no held inbound transfers');
    for (const h of holds) {
      write(`#${h.id} ${h.amount} ${h.denom} from ${h.sender} to ${h.receiver} via ${h.channel} (seq ${h.sequence}), released ${new Date(h.releaseAt * 1000).toISOString()}${h.stuck ? ` STUCK: ${h.stuck}` : ''}`);
    }
    return 0;
  }
  if (cmd === 'ibc-hold-cancel') {
    if (!/^\d+$/.test(String(rest[0]))) throw new Error('id: a number (zetaphy security ibc-holds)');
    const { me, signer } = pqSigner();
    if (st.ibcHoldGuardian !== me.bech32) throw new Error(`this account (${me.bech32}) is not the IBC hold guardian (${st.ibcHoldGuardian || 'none set'})`);
    const r = await client.ibcHoldCancel({ ...signer, id: BigInt(rest[0]) });
    write(`held transfer ${rest[0]} returned: the relayer carries the error acknowledgement back and the source chain refunds the sender`);
    landed(r);
    return 0;
  }
  return 1;
}
