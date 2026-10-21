// zetaphy bridge open | close | pause | gates | cap | monitor (cli.js hands these over).
// The bridge is deployed closed (deploy-bridge); `bridge open` checks every opening
// gate (src/bridgegate.js) and only then enables the route, through governance.

import { Contract, getAddress, parseUnits, formatUnits } from 'ethers';
import { readFileSync, writeFileSync, existsSync, renameSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { devnetOf, auditArgs, roleChecks, laneChecks, capProblems, runnerProblems, STARTER_UNITS, MIN_RUNNERS, GOV_MODULE } from './bridgegate.js';
import { evaluate, newState, report, snapshotOf, readEvents, readLocks, loadMonitorConfig, DEFAULTS } from './monitor.js';

const art = (n) => JSON.parse(readFileSync(new URL(`../artifacts/${n}.json`, import.meta.url), 'utf8'));
const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
const units = (v, d) => formatUnits(v, d).replace(/\.0$/, '');
const TOKEN = ['function decimals() view returns (uint8)', 'function symbol() view returns (string)'];

/** A governance call on a bridge contract: sent when this key is its governance, else printed for the multisig / a gov vote. */
export async function govCall(k, c, write, fn, args, what) {
  const gov = getAddress(String(await k.governance()));
  if (same(gov, c.me)) {
    await (await k[fn](...args)).wait();
    write(`${what} (done)`);
    return true;
  }
  const data = k.interface.encodeFunctionData(fn, args);
  write(`${what}: governance is ${gov}, not this key. Have it call:\n  to ${k.target}\n  data ${data}`);
  if (same(gov, GOV_MODULE)) write('  (the gov module: submit this as a MsgEVMCall proposal, zetaphy-chain/gov.sh)');
  else write('  (SimpleMultisig: an owner calls propose(to, 0, data), others confirm, then execute; Safe: Transaction Builder, each owner signs on a hardware wallet)');
  return false;
}

function bridgeContracts(s, opt, runner) {
  const guardAddr = opt.bridgeGuard ?? s.bridgeGuard;
  const airlockAddr = opt.airlock ?? s.airlock;
  if (!ADDR_RE.test(String(guardAddr ?? '')) || !ADDR_RE.test(String(airlockAddr ?? ''))) throw new Error('set --bridgeGuard 0x… and --airlock 0x… (or run deploy-bridge)');
  return { guard: new Contract(guardAddr, art('BridgeGuard').abi, runner), airlock: new Contract(airlockAddr, art('BridgeAirlock').abi, runner) };
}

/** Every gate, read from the chain. Returns { problems, warnings, lanes, roles, ... }; prints the table for a human. */
export async function openGates({ provider, guard, airlock, jobs, deployer, rpc, opt, write }) {
  const devnet = devnetOf(rpc, opt);
  const allowEoa = !!opt['allow-eoa-for-testing'];
  const problems = [], warnings = [];
  // audit
  let audit = null;
  try { audit = auditArgs(opt['audit-report'], opt['audit-sha256']); } catch (e) { problems.push(e.message); }
  // runners
  const min = Number(opt['min-runners'] ?? MIN_RUNNERS);
  if (!Number.isInteger(min) || min < 1) problems.push('--min-runners: a whole number');
  else if (min < MIN_RUNNERS && !devnet) problems.push(`--min-runners ${min}: below ${MIN_RUNNERS} only on a devnet`);
  const runners = await runnerProblems(jobs, min);
  problems.push(...runners.problems);
  // lanes
  const lanes = await laneChecks(provider, airlock, { deployer, devnet, allowEoa });
  problems.push(...lanes.problems); warnings.push(...lanes.warnings);
  // roles: governance of the guard, the airlock and every lane that has one; the guard's guardians
  const governance = [await guard.governance(), await airlock.governance(), ...lanes.lanes.map((l) => l.admin).filter(Boolean)];
  const roles = await roleChecks(provider, { governance, guardians: await guard.guardians() }, { deployer, devnet, allowEoa });
  problems.push(...roles.problems); warnings.push(...roles.warnings);
  // caps
  const token = new Contract(await guard.token(), TOKEN, provider);
  const decimals = Number(await token.decimals());
  const limitUnits = parseUnits(String(opt['daily-limit'] ?? STARTER_UNITS), decimals);
  const maxDailyLimit = await guard.maxDailyLimit();
  problems.push(...capProblems({ limitUnits, decimals, raiseCap: !!opt['raise-cap'], maxDailyLimit }));
  // real funds
  if (!devnet && !opt['i-understand-real-funds']) problems.push('this is not a devnet: pass --i-understand-real-funds once every gate above is met (real users\' money will cross)');
  if (await guard.paused()) warnings.push('BridgeGuard is paused: the route opens, but nothing crosses until governance unpauses');

  write(`Bridge ${devnet ? '(devnet)' : '(NOT a devnet)'}: BridgeGuard ${guard.target}, BridgeAirlock ${airlock.target}, threshold ${await airlock.threshold()}, quarantine ${await airlock.quarantine()}s`);
  write(`Lanes (${lanes.independent} independent, by controller): check each by hand`);
  for (const l of lanes.lanes) write(`  ${l.kind.padEnd(13)} ${l.lane}  controller ${l.controller}  admin ${l.admin ?? '(none: immutable)'}${l.ism !== undefined ? `  ISM ${l.ism}` : ''}`);
  write('Roles:');
  for (const i of roles.infos) write(`  ${i.role.padEnd(10)} ${i.address}  ${i.kind}${i.owners ? ` ${i.threshold}-of-${i.owners.length}: ${i.owners.join(', ')}` : ''}`);
  write(`Neuro runners: ${runners.active} active (need ${min})`);
  write(`Daily limit: ${units(limitUnits, decimals)} (hard cap ${units(maxDailyLimit, decimals)}, starter ${STARTER_UNITS})`);
  write(`Audit: ${audit ? `${audit.url} sha256 ${audit.sha}` : '(missing)'}${(await guard.auditSha256()) !== '0x' + '0'.repeat(64) ? ` (on-chain now: ${await guard.auditUrl()} ${await guard.auditSha256()})` : ''}`);
  for (const w of warnings) write(`warning: ${w}`);
  return { problems, warnings, audit, limitUnits, lanes, roles, runners, devnet };
}

export async function bridgeCommand({ cmd, rest, opt, env, write, s, connect, connectRpc }) {
  if (cmd === 'gates' || cmd === 'open') {
    const c = await connect(s);
    const { guard, airlock } = bridgeContracts(s, opt, c.signer);
    const g = await openGates({ provider: c.provider, guard, airlock, jobs: c.jobs, deployer: c.me, rpc: s.rpc, opt, write });
    if (g.problems.length) {
      write(`\nThe bridge stays CLOSED: ${g.problems.length} gate(s) not met:`);
      for (const p of g.problems) write(`  - ${p}`);
      return 1;
    }
    if (cmd === 'gates') { write('\nevery gate is met (nothing sent: zetaphy bridge open to enable the route)'); return 0; }
    write('');
    if (!(same(await guard.auditSha256(), g.audit.sha) && (await guard.auditUrl()) === g.audit.url)) {
      if (!(await govCall(guard, c, write, 'setAudit', [g.audit.url, g.audit.sha], `record the audit on-chain (BridgeGuard.setAudit)`))) {
        write('then run zetaphy bridge open again (enabling needs the audit on-chain first)');
        return 0;
      }
    }
    const route = await airlock.route();
    const done = await govCall(guard, c, write, 'setRoute', [route, airlock.target, g.limitUnits, true], `enable route ${route} (daily limit ${g.limitUnits} units)`);
    if (done) write('bridge OPEN. Watch it: zetaphy bridge monitor; stop it: a guardian runs zetaphy bridge pause');
    return 0;
  }

  if (cmd === 'close' || cmd === 'pause') {
    const c = await connect(s, { needJobs: false });
    const { guard, airlock } = bridgeContracts(s, opt, c.signer);
    if (cmd === 'pause') {
      if ((await guard.guardian(c.me)) || same(await guard.governance(), c.me)) { await (await guard.pause()).wait(); write('BridgeGuard paused (only governance can unpause)'); return 0; }
      write(`not a guardian: have the guardian multisig call\n  to ${guard.target}\n  data ${guard.interface.encodeFunctionData('pause', [])}`);
      return 0;
    }
    const route = await airlock.route();
    const r = await guard.routes(route);
    await govCall(guard, c, write, 'setRoute', [route, r.adapter, r.dailyLimit, false], `close route ${route}`);
    return 0;
  }

  if (cmd === 'cap') {
    const c = await connect(s, { needJobs: false });
    const { guard } = bridgeContracts(s, opt, c.signer);
    const decimals = Number(await new Contract(await guard.token(), TOKEN, c.provider).decimals());
    const fmt = (v) => units(v, decimals);
    const [sub, value] = rest;
    if (!sub || sub === 'show') {
      const at = await guard.pendingMaxAt();
      write(`maxDailyLimit ${fmt(await guard.maxDailyLimit())}${at > 0n ? `; pending ${fmt(await guard.pendingMaxDailyLimit())} from ${new Date(Number(at) * 1000).toISOString()}` : ''}`);
      return 0;
    }
    if (sub === 'propose') {
      if (!/^\d+(\.\d+)?$/.test(String(value ?? ''))) throw new Error('usage: zetaphy bridge cap propose <whole tokens> (a raise: at most x2, applied 7 days later; a cut: at once)');
      await govCall(guard, c, write, 'proposeMaxDailyLimit', [parseUnits(String(value), decimals)], `propose maxDailyLimit ${value}`);
      return 0;
    }
    if (sub === 'apply') { await (await guard.applyMaxDailyLimit()).wait(); write(`maxDailyLimit now ${fmt(await guard.maxDailyLimit())}`); return 0; }
    if (sub === 'cancel') { await govCall(guard, c, write, 'cancelMaxDailyLimit', [], 'cancel the pending cap raise'); return 0; }
    throw new Error('usage: zetaphy bridge cap [show | propose <tokens> | apply | cancel]');
  }

  if (cmd === 'monitor') return monitorCommand({ opt, env, write, s, connectRpc });
  return null;
}

const loadJson = (f) => (f && existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null);
function saveJson(f, v) {
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f + '.tmp', JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x), 2) + '\n');
  renameSync(f + '.tmp', f);
}

/**
 * zetaphy bridge monitor: one scan from the last scanned block (--state) to the head (at most
 * maxBlocks), a JSON report (--out) and a summary in English and Thai (--summary, and stdout).
 * Exit 0 (alerts or not) unless --fail-on-alert (then 3 with alerts). Without a deployed bridge:
 * a notice, exit 0.
 */
export async function monitorCommand({ opt, env, write, s, connectRpc }) {
  const cfg = loadMonitorConfig({ configFile: opt['monitor-config'], launchStateFile: opt['launch-state'] });
  const guardAddr = opt.bridgeGuard ?? cfg.bridgeGuard ?? s.bridgeGuard;
  const airlockAddr = opt.airlock ?? cfg.bridgeAirlock ?? s.airlock;
  const out = opt.out ? String(opt.out) : null;
  if (!ADDR_RE.test(String(guardAddr ?? '')) || !ADDR_RE.test(String(airlockAddr ?? ''))) {
    write('notice: no bridge deployed (no BridgeGuard / BridgeAirlock address in the monitor config or the launch state): nothing to watch');
    if (out) saveJson(out, { format: 'zetaphy-bridge-monitor/1', deployed: false, alerts: [], summary: { en: 'No bridge deployed.', th: 'ยังไม่มีสะพาน' } });
    return 0;
  }
  const rpc = s.rpc ?? opt.rpc ?? env.ZETAPHY_RPC ?? cfg.rpc;
  const provider = await connectRpc({ rpc });
  if ((await provider.getCode(guardAddr)) === '0x') {
    write(`notice: no contract at BridgeGuard ${guardAddr} on this chain: nothing to watch`);
    if (out) saveJson(out, { format: 'zetaphy-bridge-monitor/1', deployed: false, alerts: [], summary: { en: 'No bridge contract at the configured address.', th: 'ไม่พบสัญญาสะพานที่ที่อยู่ที่ตั้งไว้' } });
    return 0;
  }
  const num = (k, d) => (opt[k] != null ? Number(opt[k]) : cfg[k] ?? d);
  const rules = { volumePct: num('volume-pct', cfg.volumePct ?? DEFAULTS.volumePct), largePct: num('large-pct', cfg.largePct ?? DEFAULTS.largePct),
    silentMinutes: num('silent-minutes', cfg.silentMinutes ?? DEFAULTS.silentMinutes), disagreeMinutes: num('disagree-minutes', cfg.disagreeMinutes ?? DEFAULTS.disagreeMinutes) };
  const guard = new Contract(guardAddr, art('BridgeGuard').abi, provider);
  const airlock = new Contract(airlockAddr, art('BridgeAirlock').abi, provider);
  const stateFile = opt.state ? String(opt.state) : null;
  const state = loadJson(stateFile) ?? newState();
  const head = await provider.getBlockNumber();
  const maxBlocks = Number(opt['max-blocks'] ?? cfg.maxBlocks ?? DEFAULTS.maxBlocks);
  const from = opt['from-block'] != null ? Number(opt['from-block']) : state.lastBlock != null ? state.lastBlock + 1
    : cfg.startBlock != null ? Number(cfg.startBlock) : Math.max(0, head - DEFAULTS.lookback);
  const to = Math.min(head, from + maxBlocks - 1);
  const tokenAddr = await guard.token();
  const snapshot = await snapshotOf({ guard, airlock, token: tokenAddr === '0x' + '0'.repeat(40) ? null : new Contract(tokenAddr, TOKEN, provider), routeIds: state.routes ?? [] });
  const sources = [{ source: 'guard', address: guardAddr }, { source: 'airlock', address: airlockAddr }];
  for (const l of snapshot.lanes) {
    if ((await provider.getCode(l)) === '0x') continue;
    let kind = 'neuroLane';
    try { await new Contract(l, ['function mailbox() view returns (address)'], provider).mailbox(); kind = 'hyperlaneLane'; } catch { /* NeuroLane */ }
    sources.push({ source: kind, address: l });
  }
  const regs = new Set([String(snapshot.threats), String(await guard.threats())].filter((x) => !/^0x0{40}$/i.test(x)).map((x) => x.toLowerCase()));
  for (const r of regs) sources.push({ source: 'threats', address: r });
  const events = to >= from ? await readEvents(provider, sources, from, to) : [];
  // Optional: the source chain's lockbox, so a deposit no lane attested is seen.
  const srcRpc = opt['source-rpc'] ?? cfg.sourceRpc;
  const lockbox = opt.lockbox ?? cfg.lockbox;
  if (srcRpc && ADDR_RE.test(String(lockbox ?? ''))) {
    const { JsonRpcProvider } = await import('ethers');
    const sp = new JsonRpcProvider(String(srcRpc));
    const sh = await sp.getBlockNumber();
    state.sourceBlocks ??= {};
    const key = String(lockbox).toLowerCase();
    const sFrom = state.sourceBlocks[key] ?? Math.max(0, sh - DEFAULTS.lookback);
    const sTo = Math.min(sh, sFrom + maxBlocks - 1);
    if (sTo >= sFrom) events.push(...await readLocks(sp, String(lockbox), sFrom, sTo));
    state.sourceBlocks[key] = sTo + 1;
  }
  events.sort((a, b) => (a.source === 'lockbox') - (b.source === 'lockbox') || a.block - b.block);
  const now = Number((await provider.getBlock('latest')).timestamp);
  const { alerts, state: next } = evaluate({ events, snapshot, state, now, cfg: rules });
  next.lastBlock = Math.max(to, state.lastBlock ?? -1);
  const chainId = Number((await provider.getNetwork()).chainId);
  const rep = report({ alerts, chainId, fromBlock: from, toBlock: to, addresses: { bridgeGuard: guardAddr, bridgeAirlock: airlockAddr }, snapshot, now });
  rep.deployed = true;
  rep.caughtUp = to >= head;
  if (stateFile) saveJson(stateFile, next);
  if (out) saveJson(out, rep);
  if (opt.summary) { mkdirSync(dirname(String(opt.summary)), { recursive: true }); writeFileSync(String(opt.summary), `${rep.summary.th}\n\n${rep.summary.en}\n`); }
  write(rep.summary.en);
  write(rep.summary.th);
  if (!rep.caughtUp) write(`(scanned up to block ${to} of ${head}; the next run continues from there)`);
  return alerts.length && opt['fail-on-alert'] ? 3 : 0;
}

