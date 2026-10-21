// zetaphy deploy-oracle | oracle feed | status | poke | pause | push | relay-pyth (cli.js hands these over).
// ZetaphyOracle prices an asset from a DEX TWAP (TwapRecorder) and Pyth (ZetaphyPythRelay until Pyth
// itself, or a Hyperlane route, is on ZETAPHY), or reverts naming why not. Its settings belong to
// the ZetaphyTimelock; a guardian pauses a feed at once.

import { Contract, ContractFactory, getAddress, isHexString } from 'ethers';
import { readFileSync } from 'node:fs';
import { PROBLEMS, encodePriceFeed, fromHermes, hermesUrl, usd } from './oracle.js';
import { timelockHint } from './timelockcli.js';

const art = (n) => JSON.parse(readFileSync(new URL(`../artifacts/${n}.json`, import.meta.url), 'utf8'));
const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
const num = (v, d, what, max = 2 ** 32 - 1) => {
  const n = v == null ? d : Number(v);
  if (!Number.isInteger(n) || n < 0 || n > max) throw new Error(`${what}: a whole number up to ${max}`);
  return n;
};
/** poke's gas: fixed, since an estimate made when no observation is due is too low once one is. */
export const POKE_GAS = 800_000n;
const list = (v) => String(v ?? '').split(',').map((x) => x.trim()).filter(Boolean);

function oracleAt(s, opt, runner) {
  const a = opt.oracle ?? s.oracle;
  if (!ADDR_RE.test(String(a ?? ''))) throw new Error('no oracle: pass --oracle 0x… (or run zetaphy deploy-oracle)');
  return new Contract(getAddress(String(a)), art('ZetaphyOracle').abi, runner);
}

/** Sends a governance call when this key is governance; else prints the timelock / multisig route. */
async function govSend(k, c, write, fn, args, what, read = 'governance') {
  const gov = await k[read]();
  if (same(gov, c.me)) { await (await k[fn](...args)).wait(); write(`${what} (done)`); return true; }
  const data = k.interface.encodeFunctionData(fn, args);
  const hint = await timelockHint(c.provider, gov, k.target, data);
  write(hint ? `${what}: ${hint.join('\n')}` : `${what}: governance is ${gov}, not this key. Have it call:\n  to ${k.target}\n  data ${data}`);
  return false;
}

export async function oracleCommand({ group, cmd, rest, opt, env, write, s, connect, saveSettings }) {
  if (group === 'deploy-oracle') {
    const c = await connect(s, { needJobs: false });
    const deploy = async (n, args) => { const a = art(n); const k = await new ContractFactory(a.abi, a.bytecode, c.signer).deploy(...args); await k.waitForDeployment(); return k.getAddress(); };
    const recorder = await deploy('TwapRecorder', [num(opt['min-spacing'], 60, '--min-spacing')]);
    let pyth = opt.pyth && opt.pyth !== true ? getAddress(String(opt.pyth)) : null;
    let pythRelay = null;
    if (!pyth) {
      const relayers = list(opt.relayers);
      if (relayers.some((r) => !ADDR_RE.test(r))) throw new Error('--relayers 0x…,0x…: keys that may push Pyth updates');
      pythRelay = await deploy('ZetaphyPythRelay', [c.me, relayers, num(opt['relay-threshold'], 1, '--relay-threshold', 255) || 1]);
      pyth = pythRelay;
    }
    const oracle = await deploy('ZetaphyOracle', [c.me, recorder, pyth]);
    const k = new Contract(oracle, art('ZetaphyOracle').abi, c.signer);
    for (const g of list(opt.guardian)) { if (!ADDR_RE.test(g)) throw new Error('--guardian 0x…'); await (await k.setGuardian(g, true)).wait(); }
    saveSettings({ oracle, twapRecorder: recorder, ...(pythRelay ? { pythRelay } : {}) });
    write(`TwapRecorder ${recorder} (an observation per pair every ${num(opt['min-spacing'], 60, '--min-spacing')} s at most; anyone records)`);
    if (pythRelay) write(`ZetaphyPythRelay ${pythRelay} (Pyth's IPyth; ${list(opt.relayers).length} relayer(s), threshold ${opt['relay-threshold'] ?? 1})`);
    write(`ZetaphyOracle ${oracle} (governance: this key until handed to the timelock: zetaphy oracle feed … then setGovernance)`);
    return 0;
  }
  if (group !== 'oracle') return null;

  if (cmd === 'feed') {
    const asset = rest[0];
    if (!ADDR_RE.test(String(asset ?? ''))) throw new Error('usage: zetaphy oracle feed <asset 0x…> [--pair 0x… --window 1800 --min-observations 10 --max-segment-gap 2000 --min-liquidity 10000] [--pyth-id 0x… --max-age 120 --max-conf 100] [--max-deviation 200 --max-change 1500 --max-window-change 3000 --change-window 3600]');
    const c = await connect(s, { needJobs: false });
    const k = oracleAt(s, opt, c.signer);
    if (opt.pair) {
      const minLiq = BigInt(Math.round(Number(opt['min-liquidity'] ?? 10000))) * 10n ** 18n;
      await govSend(k, c, write, 'setTwap', [asset, getAddress(String(opt.pair)), num(opt.window, 1800, '--window'), num(opt['min-observations'], 10, '--min-observations', 96),
        num(opt['max-segment-gap'], 2000, '--max-segment-gap', 65535), minLiq], `TWAP source of ${asset}: pair ${opt.pair}`);
    }
    if (opt['pyth-id']) {
      if (!isHexString(String(opt['pyth-id']), 32)) throw new Error('--pyth-id: 0x + 64 hex (a Pyth price feed id)');
      await govSend(k, c, write, 'setPythFeed', [asset, String(opt['pyth-id']), num(opt['max-age'], 120, '--max-age'), num(opt['max-conf'], 100, '--max-conf', 10000)], `Pyth source of ${asset}: ${opt['pyth-id']}`);
    }
    await govSend(k, c, write, 'setGuards', [asset, num(opt['max-deviation'], 200, '--max-deviation', 10000), num(opt['max-change'], 1500, '--max-change', 10000),
      num(opt['max-window-change'], 3000, '--max-window-change', 10000), num(opt['change-window'], 3600, '--change-window')], `guards of ${asset}`);
    return 0;
  }

  if (cmd === 'status') {
    const c = await connect(s, { needJobs: false });
    const k = oracleAt(s, opt, c.provider);
    const assets = rest.length ? rest : await k.assets();
    write(`ZetaphyOracle ${k.target}: governance ${await k.governance()}, Pyth ${await k.pyth()}, recorder ${await k.recorder()}`);
    for (const a of assets) {
      const [t, y, g, st] = await Promise.all([k.twapOf(a), k.pythOf(a), k.guardsOf(a), k.stateOf(a)]);
      write(`${a}${st.paused ? '  PAUSED' : ''}${st.tripped ? '  CIRCUIT BREAKER TRIPPED (governance resets it)' : ''}`);
      if (t.pair !== '0x' + '0'.repeat(40)) write(`  TWAP  pair ${t.pair}, window ${t.window} s, ≥ ${t.minObservations} observations, segment gap ≤ ${t.maxSegmentGapBps} bps, depth ≥ ${usd(t.minLiquidity)}`);
      if (y.id !== '0x' + '0'.repeat(64)) write(`  Pyth  ${y.id}, ≤ ${y.maxAge} s old, confidence ≤ ${y.maxConfBps} bps`);
      write(`  guards: sources within ${g.maxDeviationBps} bps; change ≤ ${g.maxChangeBps} bps per update, ≤ ${g.maxWindowChangeBps} bps per ${g.changeWindow} s`);
      const [v, at, p, x, z] = await k.livePrice(a);
      write(`  live:  ${Number(p) === 0 ? `${usd(v)} (as of ${new Date(Number(at) * 1000).toISOString()})` : `unavailable: ${PROBLEMS[Number(p)]} (${x}, ${z})`}`);
      try { const [pv] = await k.price(a); write(`  price(): ${usd(pv)}`); } catch (e) { write(`  price(): reverts ${e.revert?.name ?? e.shortMessage ?? 'error'}${e.revert?.args ? ` (${[...e.revert.args].join(', ')})` : ''}`); }
      write(`  reference ${st.lastPrice ? usd(st.lastPrice) : '(none: poke it)'}`);
    }
    return 0;
  }

  if (cmd === 'poke') {
    if (!rest.length) throw new Error('usage: zetaphy oracle poke <asset 0x…>... (anyone: records a TWAP observation, moves the reference)');
    const c = await connect(s, { needJobs: false });
    const k = oracleAt(s, opt, c.signer);
    for (const a of rest) {
      const rc = await (await k.poke(a, { gasLimit: POKE_GAS })).wait();
      const evs = rc.logs.map((l) => { try { return k.interface.parseLog(l); } catch { return null; } }).filter(Boolean);
      const e = evs.find((x) => x.name !== 'Poked') ?? evs.find((x) => x.name === 'Poked');
      write(`${a}: ${!e ? 'nothing new (paused, tripped or no change)' : e.name === 'Poked' ? `reference ${usd(e.args.price)}` : e.name === 'SourceProblem' ? `SourceProblem ${PROBLEMS[Number(e.args.problem)]}` : e.name}`);
    }
    return 0;
  }

  if (cmd === 'pause') {
    if (!ADDR_RE.test(String(rest[0] ?? ''))) throw new Error('usage: zetaphy oracle pause <asset 0x…>   (a guardian or governance: at once)');
    const c = await connect(s, { needJobs: false });
    const k = oracleAt(s, opt, c.signer);
    await (await k.pauseFeed(rest[0])).wait();
    write(`${rest[0]}: feed paused (only governance, through the timelock, unpauses: unpauseFeed)`);
    return 0;
  }

  if (cmd === 'push' || cmd === 'relay-pyth') {
    const c = await connect(s, { needJobs: false });
    const relayAddr = opt.relay ?? s.pythRelay;
    if (!ADDR_RE.test(String(relayAddr ?? ''))) throw new Error('no ZetaphyPythRelay: pass --relay 0x…');
    const relay = new Contract(getAddress(String(relayAddr)), art('ZetaphyPythRelay').abi, c.signer);
    if (!(await relay.isRelayer(c.me))) throw new Error(`${c.me} is not a relayer of ${relay.target} (governance: setRelayer)`);
    if (cmd === 'push') {
      if (!isHexString(String(opt.feed ?? ''), 32) || opt.price == null) throw new Error('usage: zetaphy oracle push --feed 0x<id> --price <int> [--conf <int> --expo -8 --publish-time <unix>]');
      const t = opt['publish-time'] ?? (await c.provider.getBlock('latest')).timestamp;
      const data = encodePriceFeed({ id: String(opt.feed), price: BigInt(String(opt.price)), conf: BigInt(String(opt.conf ?? 0)), expo: Number(opt.expo ?? -8), publishTime: t });
      await (await relay.updatePriceFeeds([data])).wait();
      write(`pushed ${opt.feed}: ${opt.price} x 10^${opt.expo ?? -8} at ${t}`);
      return 0;
    }
    const ids = list(opt.feed);
    const url = hermesUrl(ids, opt.hermes ?? env.PYTH_HERMES_URL ?? undefined);
    const every = Number(opt.every ?? 0);
    for (;;) {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`Hermes answered ${r.status}`);
      const data = fromHermes(await r.json());
      await (await relay.updatePriceFeeds(data)).wait();
      write(`${new Date().toISOString()} relayed ${data.length} Pyth price(s) from Hermes`);
      if (!every || opt.once) return 0;
      await new Promise((res) => setTimeout(res, every * 1000));
    }
  }
  throw new Error('usage: zetaphy oracle feed <asset> … | status [asset] | poke <asset>… | pause <asset> | push --feed … | relay-pyth --feed <id,…> [--every 30]');
}
