// Saphan PR 6 commands (docs/SAPHAN-PR6.md), reached through scripts/saphan.js:
//
//   node scripts/saphan.js recovery plan [--state state.json]
//       the guided path after an incident (pause -> snapshot -> claims -> resume): every step, done or not, and the next
//   node scripts/saphan.js recovery snapshot --events events.json [--exclude 0x…,0x…]
//       who is owed what (src/saphanrecovery.js) and the claims file: root, total, each address's owed + proof
//       events.json: { transfers: [{from,to,value}], releasesQueued: [{id,to,amount}], released: [id], locks: [{transferId,sender,amount}], minted: [id] }
//   node scripts/saphan.js recovery read --token 0x… --to <block> [--from <block>] [--airlock 0x…] [--chain <name> --lockbox 0x…]
//       reads those events (ZETAPHY_RPC; ORIGIN_RPC or the table's for the source chain): events.json on stdout
//   node scripts/saphan.js recovery proof --file claims.json --account 0x…
//   node scripts/saphan.js recovery start --claims 0x… --file claims.json [--delay 172800]
//       the timelock calls (schedule / execute) that set the root on SaphanRecoveryClaims
//
//   node scripts/saphan.js liquidity plan --flows flows.json --current <wei> --min <wei> --max <wei> --step <bps> [--limit <wei>] [--hint '<json>'] [--now <unix>]
//       the next target of a route (deterministic; the hint may only nudge it), and the raise proposal when needed
//
//   node scripts/saphan.js offline sign --contract 0x… --outbox 0x… --to 0x… --amount <wei> [--fee <wei>] [--deadline <unix>] [--nonce <n>] [--chain-id 77390]
//       signs with KEYFILE, offline; prints the ZSPH1: text (a QR code of it works the same)
//   node scripts/saphan.js offline check --payload ZSPH1:…        offline checks (signature, deadline, known route)
//   node scripts/saphan.js offline relay --payload ZSPH1:…        relays it on ZETAPHY (KEYFILE pays the Mailbox fee, earns the fee)
//
//   node scripts/saphan.js heal once [--act yes]
//       one tick of the self-healing watcher over every deployed two-way route: stuck messages, heartbeats, anomalies.
//       Without --act it only says what it would do.
//   node scripts/saphan.js bitvm judge --claim claim.json --tx <raw hex|"">   a watcher's decision for one claim
//   node scripts/saphan.js privacy note --pool 0x… [--chain-id 77390]          a new note (keep it secret) and its commitment
import { readFileSync } from 'node:fs';
import { Interface, Wallet, Contract, getAddress, keccak256, toUtf8Bytes } from 'ethers';

const TIMELOCK = new Interface(['function schedule(address,uint256,bytes,bytes32,bytes32,uint256)', 'function execute(address,uint256,bytes,bytes32,bytes32)']);
const CLAIMS = new Interface(['function start(bytes32 root, uint256 total)']);
const json = (f) => JSON.parse(readFileSync(String(f), 'utf8'));
const need = (o, ks) => { for (const k of ks) if (o[k] == null) throw new Error(`--${k} is needed`); };
const str = (x) => JSON.parse(JSON.stringify(x, (_, v) => (typeof v === 'bigint' ? v.toString() : v)));

export const COMMANDS = ['recovery', 'liquidity', 'offline', 'heal', 'bitvm', 'privacy'];

/** One command: (cmd, sub, options, helpers from scripts/saphan.js) -> a JSON-able result. */
export async function run(cmd, sub, o, h = {}) {
  if (cmd === 'recovery') {
    const R = await import('../src/saphanrecovery.js');
    if (sub === 'plan') return R.plan(o.state ? json(o.state) : {});
    if (sub === 'snapshot') {
      need(o, ['events']);
      const s = R.snapshot({ ...json(o.events), exclude: o.exclude ? String(o.exclude).split(',') : [] });
      return { ...R.claimsFile(s.entries), excluded: s.excluded.map(([x, v]) => [x, v.toString()]) };
    }
    if (sub === 'proof') {
      need(o, ['file', 'account']);
      const f = json(o.file);
      const line = f.claims[getAddress(o.account)];
      if (!line) throw new Error(`${o.account} is not owed anything in ${o.file}`);
      return { account: getAddress(o.account), ...line, root: f.root };
    }
    if (sub === 'start') {
      need(o, ['claims', 'file']);
      const f = json(o.file);
      const data = CLAIMS.encodeFunctionData('start', [f.root, BigInt(f.total)]);
      const salt = keccak256(toUtf8Bytes(`saphan-recovery:${f.root}`));
      const zero = '0x' + '00'.repeat(32);
      const delay = BigInt(o.delay ?? 172800);
      return { target: getAddress(o.claims), data, salt, delay: delay.toString(),
        schedule: TIMELOCK.encodeFunctionData('schedule', [getAddress(o.claims), 0n, data, zero, salt, delay]),
        execute: TIMELOCK.encodeFunctionData('execute', [getAddress(o.claims), 0n, data, zero, salt]) };
    }
    if (sub === 'read') {
      need(o, ['token', 'to']);
      const zetaphy = await h.zetaphyP();
      const source = o.chain && o.lockbox ? await h.originP(o.chain) : null;
      return str(await R.readEvents({ zetaphy, token: getAddress(o.token), airlock: o.airlock ?? null, source, lockbox: o.lockbox ?? null,
        fromBlock: Number(o.from ?? 0), toBlock: Number(o.to), sourceFrom: Number(o['source-from'] ?? 0) }));
    }
  }
  if (cmd === 'liquidity' && sub === 'plan') {
    const L = await import('../src/saphanliquidity.js');
    need(o, ['flows', 'current', 'min', 'max', 'step']);
    const hint = o.hint ? L.parseHint(o.hint) : null;
    const p = L.plan({ flows: json(o.flows), now: Number(o.now ?? Math.floor(Date.now() / 1000)), current: BigInt(o.current),
      bounds: { min: BigInt(o.min), max: BigInt(o.max), maxStepBps: Number(o.step) }, lockboxLimit: o.limit != null ? BigInt(o.limit) : null, hint });
    return str({ ...p, hint, raise: p.needsGovernance && o.lockbox ? L.raiseProposal({ lockbox: o.lockbox, value: p.target }) : null });
  }
  if (cmd === 'offline') {
    const O = await import('../src/saphanoffline.js');
    if (sub === 'sign') {
      need(o, ['contract', 'outbox', 'to', 'amount']);
      const key = new Wallet(readFileSync(String(process.env.KEYFILE), 'utf8').trim());
      const transfer = { from: key.address, outbox: o.outbox, to: o.to, amount: o.amount, relayerFee: o.fee ?? '0',
        nonce: o.nonce ?? O.newNonce().toString(), deadline: o.deadline ?? String(Math.floor(Date.now() / 1000) + 7 * 86400) };
      const chainId = Number(o['chain-id'] ?? 77390);
      const sig = await O.signTransfer({ chainId, contract: o.contract, transfer, key });
      return { payload: O.encodePayload({ chainId, contract: o.contract, transfer, sig }) };
    }
    if (sub === 'check' || sub === 'relay') {
      need(o, ['payload']);
      const p = O.decodePayload(o.payload);
      const known = h.routes ? Object.values(h.routes()).map((r) => r?.zetaphy?.hyperlaneOutbox).filter(Boolean) : null;
      const v = O.verifyPayload(p, { knownOutboxes: known && known.length ? known : null });
      if (sub === 'check') return str({ ...v, transfer: p.transfer, contract: p.contract, chainId: p.chainId });
      if (!v.ok) throw new Error(`not relayed: ${v.problems.join(', ')}`);
      const zp = await h.zetaphyP();
      const k = new Contract(p.contract, JSON.parse(readFileSync(new URL('../artifacts/SaphanOfflineTransfers.json', import.meta.url), 'utf8')).abi, h.keySigner(zp));
      const args = O.relayArgs(p);
      const fee = await k.quote(args[0]);
      const tx = await k.relay(...args, { value: fee });
      await tx.wait();
      return { tx: tx.hash, mailboxFee: fee.toString() };
    }
  }
  if (cmd === 'heal' && sub === 'once') {
    const H = await import('../src/saphanheal.js');
    const routes = h.routes();
    const t = h.table();
    const names = Object.keys(routes).filter((n) => routes[n]?.zetaphy?.hyperlaneOutbox && t.chains[n]);
    const zp = await h.zetaphyP();
    const readers = {};
    for (const n of names) {
      const r = routes[n];
      const p = await h.originP(n);
      readers[n] = H.routeReader({
        outbox: new Contract(r.zetaphy.hyperlaneOutbox, ['function nonce() view returns (uint256)'], zp),
        lane: r.zetaphy.hyperlaneLane ? new Contract(r.zetaphy.hyperlaneLane, ['function delivered(bytes32) view returns (bool)'], zp) : null,
        lockbox: new Contract(r.origin.lockbox, ['function received() view returns (uint256)', 'function lastHeard() view returns (uint64)', 'function nonce() view returns (uint256)',
          'function transferIds(uint256) view returns (bytes32)', 'function reserves() view returns (uint256,uint256,uint64,uint256)'], p),
      });
    }
    const act = o.act === 'yes';
    const say = (what) => async (route, ...x) => (act ? h.act?.[what]?.(route, ...x) ?? `no ${what} action wired: do it by hand` : `would ${what} ${route} ${JSON.stringify(str(x))}`);
    const w = H.createSaphanWatcher({ routes: names, read: (n) => readers[n](), act: { replay: say('replay'), beat: say('beat'), trip: say('trip') },
      options: { stuckAfter: 0 } });
    return str({ routes: names, actions: await w.tick() });
  }
  if (cmd === 'bitvm' && sub === 'judge') {
    const B = await import('../src/saphanbitvm.js');
    need(o, ['claim']);
    return B.judgeClaim(json(o.claim), o.tx ? o.tx : null);
  }
  if (cmd === 'privacy' && sub === 'note') {
    const P = await import('../src/saphanprivacy.js');
    need(o, ['pool']);
    const note = P.newNote();
    const chainId = Number(o['chain-id'] ?? 77390);
    return { note: P.encodeNote({ chainId, pool: o.pool, note }), commitment: P.noteCommitment(note).toString(),
      warning: 'keep the note secret: whoever holds it can withdraw; the pool uses a DEV trusted setup (testnet only)' };
  }
  throw new Error(`usage: saphan.js ${COMMANDS.join('|')} <sub> … (see scripts/saphan-ops.js)`);
}
