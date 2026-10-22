// The transaction insight (the vaccine for plain MetaMask), run on the built
// snap (dist/bundle.js) in MetaMask's simulated environment. The transaction's
// chain is mocked with snap.mockJsonRpc; the ZETAPHY RPC is a small JSON-RPC
// server on 127.0.0.1 standing in for the node and its ThreatRegistry.
//   npm run build && npm test
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { installSnap } from '@metamask/snaps-jest';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { threatQueries, fingerprint1, codeHash, SLOT_IMPL, SLOT_BEACON, SEL_IMPLEMENTATION, addressKey, codeKey, detailQueries, REASON_TEXT, selector } from '../../zetaphy-network/src/vaccine.js';
import { codeFingerprint } from '../../zetaphy-neuro/src/fingerprint.js';
import { destinations, analyzeCall, typedDataTargets, checkTransaction, checkSignature } from '../src/threats.js';
import { insight } from '../src/insight.jsx';

const SNAP_ID = 'local:http://localhost:18096';
// The built-in constants, as the launch wrote them into snap.config.js (placeholders before a launch).
const SNAP_ENV = readFileSync(resolve(import.meta.dirname ?? new URL('.', import.meta.url).pathname, '../snap.config.js'), 'utf8');
const builtIn = (name) => new RegExp(`${name}: '([^']*)'`).exec(SNAP_ENV)[1];
const WALLET = builtIn('ZETAPHY_WALLET_ORIGINS').split(',')[0].trim(); // the first origin allowed to set the threat source
const BUILT_IN_REGISTRY = builtIn('ZETAPHY_THREAT_REGISTRY');
const REGISTRY = '0x7777777777777777777777777777777777777777';
const TARGET = '0x3333333333333333333333333333333333333333';
const IMPL = '0x4444444444444444444444444444444444444444';
const BEACON = '0x5555555555555555555555555555555555555555';
const SPENDER = '0x6666666666666666666666666666666666666666';
const TARGET_CODE = '0x6080604052348015600f57600080fd5b50';
const IMPL_CODE = '0x60806040aa';
const word = (v) => BigInt(v).toString(16).padStart(64, '0');
const flagAnswer = (on, reason) => '0x' + word(on ? 1 : 0) + word(on ? reason : 0);
// evidenceOf / responseOf answers (ABI: (bytes32, string, address, uint64) and (string, address, uint64, uint256, address)).
const strTail = (str) => { const h = Buffer.from(str).toString('hex'); return word(h.length / 2) + h.padEnd(64 * Math.ceil(h.length / 64), '0'); };
const evidenceAnswer = (hash, uri) => '0x' + hash.slice(2) + word(128) + word('0x99') + word(5) + strTail(uri);
const responseAnswer = (text, by, chainId = 56) => '0x' + word(160) + word(by) + word(7) + word(chainId) + word(chainId ? TARGET : 0) + strTail(text);
const REPORT = '0x' + 'e7'.repeat(32);

// ---- the stand-in ZETAPHY RPC ----
const rpc = { answers: new Map(), requests: [], status: 200, chainId: '0x12e4e' };
/** Flags one key of `address` (with `code`) on chain `chainId`: what = address | code | fingerprint. */
function flag(chainId, address, code, what, reason, enforced) {
  const q = threatQueries(chainId, address, code).find((x) => x.what === what);
  rpc.answers.set(q.warn, flagAnswer(true, reason));
  rpc.answers.set(q.enforced, flagAnswer(enforced, reason));
}
let server;
let url;
beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const batch = JSON.parse(body);
      rpc.requests.push(batch);
      if (rpc.status !== 200) { res.writeHead(rpc.status); res.end('down'); return; }
      const out = batch.map((r) => {
        if (r.method === 'eth_chainId') return { jsonrpc: '2.0', id: r.id, result: rpc.chainId };
        if (r.method === 'eth_call' && r.params[0].to.toLowerCase() === REGISTRY) {
          return { jsonrpc: '2.0', id: r.id, result: rpc.answers.get(r.params[0].data) ?? flagAnswer(false, 0) };
        }
        return { jsonrpc: '2.0', id: r.id, error: { code: -32601, message: 'no' } };
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(out));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${server.address().port}`;
});
afterAll(() => new Promise((r) => server.close(r)));

// ---- the transaction's own chain (MetaMask's provider, mocked; MetaMask on BSC, 56, unless `chain`) ----
const switches = []; // wallet_switchEthereumChain calls: the snap must never make one
function mockChain(snap, { codes = {}, storage = {}, beacons = {}, fail = false, chain = '0x38' } = {}) {
  return snap.mockJsonRpc((request) => {
    if (request.method === 'eth_chainId') return chain;
    if (request.method === 'wallet_switchEthereumChain') { switches.push(request.params); return null; }
    if (!/^eth_/.test(request.method) || !Array.isArray(request.params)) return undefined;
    const [a, b] = request.params;
    if (request.method === 'eth_getCode') { if (fail) throw new Error('chain down'); return codes[a.toLowerCase()] ?? '0x'; }
    if (request.method === 'eth_getStorageAt') return '0x' + (storage[a.toLowerCase()]?.[b] ? word(storage[a.toLowerCase()][b]) : word(0));
    if (request.method === 'eth_call' && a.data === '0x' + SEL_IMPLEMENTATION) return '0x' + word(beacons[a.to.toLowerCase()] ?? 0);
    return undefined;
  });
}

/** Every line of the insight: texts, "label: value" rows, banner titles. */
function linesOf(node, out = []) {
  const flat = (c) => (c == null || typeof c === 'boolean' ? '' : typeof c === 'string' ? c : Array.isArray(c) ? c.map(flat).join('') : flat(c.props?.children));
  if (node == null || typeof node === 'boolean') return out;
  if (Array.isArray(node)) { for (const n of node) linesOf(n, out); return out; }
  if (typeof node === 'string') { out.push(node); return out; }
  const { type, props = {} } = node;
  if (type === 'Text' || type === 'Heading') out.push(flat(props.children));
  else if (type === 'Row') out.push(`${props.label}: ${props.children?.props?.address ?? flat(props.children)}`);
  else {
    if (type === 'Banner') out.push(props.title);
    linesOf(props.children, out);
  }
  return out;
}

async function inspect(snap, tx) {
  const res = await snap.onTransaction({ chainId: 'eip155:56', data: '0x', ...tx });
  expect(res.response.error).toBeUndefined();
  const ui = await res.getInterface();
  return { severity: res.response.result?.severity ?? null, text: linesOf(ui.content).join('\n') };
}

async function useLocalRpc(snap) {
  const pending = snap.request({ origin: WALLET, method: 'zetaphy_setThreatSource', params: { rpc: url, registry: REGISTRY } });
  const ui = await pending.getInterface();
  expect(linesOf(ui.content).join('\n')).toContain(url);
  await ui.ok();
  const r = await pending;
  expect(r.response.result).toEqual({ rpc: url, registry: REGISTRY, overridden: true });
}

describe('the vaccine in plain MetaMask: transaction insights', () => {
  it('the bundled fp1 is Neuro\'s fingerprint, byte for byte', async () => {
    const art = JSON.parse(readFileSync(resolve(__dirname, '../../zetaphy-network/artifacts/ThreatRegistry.json'), 'utf8'));
    for (const code of [TARGET_CODE, IMPL_CODE, art.deployedBytecode]) expect(fingerprint1(code)).toBe(await codeFingerprint(code));
  });

  it('with the built-in threat source: "couldn\'t check" until it answers (no registry yet, or not reachable from the test)', async () => {
    const snap = await installSnap(SNAP_ID);
    mockChain(snap);
    const r = await inspect(snap, { to: TARGET });
    expect(r.severity).toBeNull();
    expect(r.text).toMatch(/ZETAPHY Neuro ตรวจธุรกรรมนี้ไม่ได้ \/ ZETAPHY Neuro couldn't check this transaction\n/);
    if (/^0x0{40}$/.test(BUILT_IN_REGISTRY)) expect(r.text).toMatch(/\nno ThreatRegistry configured/);
  });

  it('only the ZETAPHY wallet\'s origin may change the threat source, after the user approves; bad input is refused', async () => {
    const snap = await installSnap(SNAP_ID);
    const other = await snap.request({ origin: 'https://evil.example', method: 'zetaphy_setThreatSource', params: { rpc: 'https://evil.example', registry: REGISTRY } });
    expect(other.response.error.code).toBe(4100);
    for (const params of [{ rpc: 'http://evil.example', registry: REGISTRY }, { rpc: url, registry: '0x' + '00'.repeat(20) }, { rpc: url }, { rpc: url, registry: REGISTRY, x: 1 },
      { rpc: 'https://user:pw@rpc.example', registry: REGISTRY }, null]) {
      const r = await snap.request({ origin: WALLET, method: 'zetaphy_setThreatSource', params });
      expect(r.response.error.code).toBe(-32602);
    }
    const pending = snap.request({ origin: WALLET, method: 'zetaphy_setThreatSource', params: { rpc: url, registry: REGISTRY } });
    await (await pending.getInterface()).cancel();
    expect((await pending).response.error.code).toBe(4001);
    expect((await snap.request({ origin: WALLET, method: 'zetaphy_getThreatSource' })).response.result.overridden).toBe(false);
    await useLocalRpc(snap);
    expect((await snap.request({ origin: WALLET, method: 'zetaphy_getThreatSource' })).response.result.registry).toBe(REGISTRY);
    // Other sites cannot read it (whether a user set a custom source could fingerprint them).
    expect((await snap.request({ origin: 'https://any.example', method: 'zetaphy_getThreatSource' })).response.error.code).toBe(4100);
    // Back to the built-in source.
    const reset = snap.request({ origin: WALLET, method: 'zetaphy_setThreatSource', params: { reset: true } });
    await (await reset.getInterface()).ok();
    expect((await reset).response.result.overridden).toBe(false);
  });

  it('nothing flagged: "no flag on what was checked", listing exactly what was checked; what is sent is only destinations, code hashes and fingerprints', async () => {
    const snap = await installSnap(SNAP_ID);
    await useLocalRpc(snap);
    mockChain(snap, { codes: { [TARGET]: TARGET_CODE } });
    rpc.answers.clear();
    rpc.requests.length = 0;
    const r = await inspect(snap, { to: TARGET, from: '0x' + '99'.repeat(20), value: '0x1' });
    expect(r.severity).toBeNull();
    expect(r.text).toContain('ZETAPHY Neuro: ไม่พบธงในสิ่งที่ตรวจ / no flag on what was checked');
    expect(r.text).toContain(`ตรวจแล้ว / checked: ปลายทาง / Destination: ${TARGET}`);
    expect(r.text).toContain('Only checked: the destination (to) plus the spender or recipient the call names (its first argument; the second for transferFrom and Permit2 approve)');
    expect(r.text).not.toMatch(/inner calls not checked/);
    expect(r.text).toContain(`custom threat source in use (zetaphy_setThreatSource): RPC ${url}, ThreatRegistry ${REGISTRY}`);
    expect(rpc.requests).toHaveLength(1); // one batch
    const sent = JSON.stringify(rpc.requests[0]);
    expect(sent).not.toContain('99'.repeat(20)); // never the user's own account
    const datas = rpc.requests[0].filter((x) => x.method === 'eth_call').map((x) => x.params[0].data);
    const expected = threatQueries(56n, TARGET, TARGET_CODE).flatMap((q) => [q.warn, q.enforced]);
    expect(datas).toEqual(expected);
    expect(expected.join()).toContain(codeHash(TARGET_CODE).slice(2));
    expect(expected.join()).toContain(fingerprint1(TARGET_CODE).slice(4));
    expect(expected.join()).toContain(word(56) + word(TARGET));
  });

  it('an enforced flag (address, code or fp1): severity critical, with a Thai/English warning and the reason', async () => {
    const snap = await installSnap(SNAP_ID);
    await useLocalRpc(snap);
    mockChain(snap, { codes: { [TARGET]: TARGET_CODE } });
    for (const [what, reason, said] of [['address', 1, 'this address is flagged'], ['code', 2, 'its code is byte-for-byte flagged code'],
      ['fingerprint', 5, 'its code fingerprint (fp1) matches flagged code']]) {
      const why = REASON_TEXT[reason].en;
      rpc.answers.clear();
      flag(56n, TARGET, TARGET_CODE, what, reason, true);
      const r = await inspect(snap, { to: TARGET });
      expect(r.severity).toBe('critical');
      expect(r.text).toContain('ธงบังคับใช้แล้ว: ZETAPHY Neuro / Enforced flag: ZETAPHY Neuro');
      expect(r.text).toContain(`เหตุผล: ${REASON_TEXT[reason].th}`);
      expect(r.text).toContain('ข้อมูลวิเคราะห์โค้ดอัตโนมัติ ไม่ใช่คำกล่าวหา / Automated code analysis, not an accusation');
      expect(r.text).not.toMatch(/scam|drainer|phishing|honeypot|หลอกลวง|ดูดเงิน/i);
      expect(r.text).toContain(`${said} · reason: ${why}`);
      expect(r.text).toMatch(/เหตุผล: /);
      expect(r.text).toContain(`ปลายทาง / Destination: ${TARGET}`);
    }
  });

  it('a flag not enforced yet: a visible warning, not critical', async () => {
    const snap = await installSnap(SNAP_ID);
    await useLocalRpc(snap);
    mockChain(snap, { codes: { [TARGET]: TARGET_CODE } });
    rpc.answers.clear();
    flag(56n, TARGET, TARGET_CODE, 'address', 5, false);
    const r = await inspect(snap, { to: TARGET });
    expect(r.severity).toBeNull();
    expect(r.text).toContain('คำเตือนจาก ZETAPHY Neuro / Warning from ZETAPHY Neuro');
    expect(r.text).toContain('the flag is not enforced yet');
    expect(r.text).toContain(`this address is flagged · reason: ${REASON_TEXT[5].en}`);
    expect(r.text).toContain('Automated code analysis, not an accusation');
  });

  it('the spender of an approve is checked too (a flagged spender with an enforced flag: critical)', async () => {
    const snap = await installSnap(SNAP_ID);
    await useLocalRpc(snap);
    mockChain(snap, { codes: { [TARGET]: TARGET_CODE } });
    rpc.answers.clear();
    flag(56n, SPENDER, '0x', 'address', 1, true);
    const approve = '0x095ea7b3' + word(SPENDER) + 'f'.repeat(64);
    const r = await inspect(snap, { to: TARGET, data: approve });
    expect(r.severity).toBe('critical');
    expect(r.text).toContain(`ผู้ได้สิทธิ์ใช้เหรียญ (approve / permit) / Spender (approve / permit): ${SPENDER}`);
  });

  it('proxies: the code behind an EIP-1167 clone, an EIP-1967 implementation or a beacon is checked as the destination', async () => {
    const snap = await installSnap(SNAP_ID);
    await useLocalRpc(snap);
    rpc.answers.clear();
    flag(56n, IMPL, IMPL_CODE, 'code', 1, true);
    const clone = '0x363d3d373d3d3d363d73' + IMPL.slice(2) + '5af43d82803e903d91602b57fd5bf3';
    for (const chain of [
      { codes: { [TARGET]: clone, [IMPL]: IMPL_CODE } },
      { codes: { [TARGET]: TARGET_CODE, [IMPL]: IMPL_CODE }, storage: { [TARGET]: { [SLOT_IMPL]: IMPL } } },
      { codes: { [TARGET]: TARGET_CODE, [IMPL]: IMPL_CODE, [BEACON]: '0x6080' }, storage: { [TARGET]: { [SLOT_BEACON]: BEACON } }, beacons: { [BEACON]: IMPL } },
    ]) {
      const m = mockChain(snap, chain);
      const r = await inspect(snap, { to: TARGET });
      m.unmock();
      expect(r.severity).toBe('critical');
      expect(r.text).toContain(`the code behind proxy ${TARGET}`);
      expect(r.text).toContain('its code is byte-for-byte flagged code');
    }
    // The same proxy in front of clean code: clean.
    rpc.answers.clear();
    mockChain(snap, { codes: { [TARGET]: clone, [IMPL]: IMPL_CODE } });
    expect((await inspect(snap, { to: TARGET })).text).toContain('no flag on what was checked');
  });

  it('check failed: the ZETAPHY RPC down, not ZETAPHY, or the chain unreadable: "couldn\'t check" (never "clean")', async () => {
    const snap = await installSnap(SNAP_ID);
    await useLocalRpc(snap);
    mockChain(snap, { codes: { [TARGET]: TARGET_CODE } });
    rpc.answers.clear();
    rpc.status = 500;
    let r = await inspect(snap, { to: TARGET });
    expect(r.text).toMatch(/couldn't check this transaction\nZETAPHY RPC HTTP 500/);
    rpc.status = 200;
    rpc.chainId = '0x1';
    r = await inspect(snap, { to: TARGET });
    expect(r.text).toMatch(/couldn't check this transaction\nthat RPC is not ZETAPHY/);
    rpc.chainId = '0x12e4e';
    const down = await installSnap(SNAP_ID);
    await useLocalRpc(down);
    mockChain(down, { fail: true });
    r = await inspect(down, { to: TARGET });
    expect(r.text).toMatch(/couldn't check this transaction\ncould not read the destination's code on its chain/);
    // ...but an address flag still shows when the code could not be read.
    flag(56n, TARGET, null, 'address', 1, true);
    r = await inspect(down, { to: TARGET });
    expect(r.severity).toBe('critical');
  });

  it('every flag shows its evidence (reportHash, how to reproduce) and the owner\'s response; no evidence or unreadable details are said so', async () => {
    const snap = await installSnap(SNAP_ID);
    await useLocalRpc(snap);
    mockChain(snap, { codes: { [TARGET]: TARGET_CODE } });
    rpc.answers.clear();
    flag(56n, TARGET, TARGET_CODE, 'address', 3, true);
    const key = addressKey(56n, TARGET);
    const OWNER = '0x' + '0a'.repeat(20);
    rpc.answers.set(detailQueries(key).evidence, evidenceAnswer(REPORT, 'neuro:bsc:0x3333'));
    rpc.answers.set(detailQueries(key).responses[0], responseAnswer('pause() is for emergencies;\u202e audited', OWNER));
    rpc.requests.length = 0;
    let r = await inspect(snap, { to: TARGET });
    expect(r.severity).toBe('critical');
    expect(r.text).toContain(`reason: ${REASON_TEXT[3].en}`);
    expect(r.text).toContain(`หลักฐาน / evidence: reportHash ${REPORT} (neuro:bsc:0x3333)`);
    expect(r.text).toContain('reproduce: run Neuro on the same code (zetaphy-neuro: node cli.js <chain> <address> --json) and compare the reportHash');
    expect(r.text).toContain(`คำชี้แจงจาก / response from ${OWNER} (สำหรับ / for 56:${TARGET}): "pause() is for emergencies; audited"`);
    expect(r.text).toContain('ข้อมูลวิเคราะห์โค้ดอัตโนมัติ ไม่ใช่คำกล่าวหา / Automated code analysis, not an accusation');
    expect(rpc.requests).toHaveLength(2); // the check, then the details of what was flagged
    const asked = rpc.requests[1].filter((x) => x.method === 'eth_call').map((x) => x.params[0].data);
    expect(asked).toContain(detailQueries(key).evidence);
    for (const q of detailQueries(key).responses) expect(asked).toContain(q);
    // A response on another key of the same destination (its code) is shown too; nothing stored: said so.
    rpc.answers.delete(detailQueries(key).evidence);
    rpc.answers.delete(detailQueries(key).responses[0]);
    rpc.answers.set(detailQueries(codeKey(codeHash(TARGET_CODE))).responses[0], responseAnswer('about the code', OWNER));
    r = await inspect(snap, { to: TARGET });
    expect(r.text).toContain('หลักฐาน / evidence: อ่านไม่ได้ / could not be read'); // the stand-in answers 64 zero bytes: not an evidenceOf answer
    expect(r.text).toContain(`response from ${OWNER} (สำหรับ / for 56:${TARGET}): "about the code"`);
    rpc.answers.delete(detailQueries(codeKey(codeHash(TARGET_CODE))).responses[0]);
    r = await inspect(snap, { to: TARGET });
    expect(r.text).toContain('ยังไม่มีคำชี้แจง / no response yet');
    rpc.answers.set(detailQueries(key).evidence, evidenceAnswer('0x' + '00'.repeat(32), ''));
    r = await inspect(snap, { to: TARGET });
    expect(r.text).toContain('หลักฐาน / evidence: ไม่มีบันทึกไว้ / none stored');
    expect(r.severity).toBe('critical'); // details never weaken the warning
  });

  it('destinations: `to`, plus the spender / operator / recipient an approve, setApprovalForAll or transfer names; a creation has none', async () => {
    // (snaps-jest cannot send a transaction without `to`, so this one calls the snap's code directly.)
    expect(destinations({ data: '0x6080' })).toEqual([]);
    expect(await checkTransaction({ transaction: { data: '0x6080' }, chainId: 'eip155:1' }, { rpc: url, registry: REGISTRY })).toEqual({ state: 'none', findings: [], checked: [] });
    expect(linesOf(insight({ state: 'none' }).content).join('\n')).toMatch(/a contract creation has no destination to check/);
    const t = TARGET;
    expect(destinations({ to: t, data: '0xa22cb465' + word(SPENDER) + word(1) })).toEqual([{ address: t, role: 'to' }, { address: SPENDER, role: 'operator' }]);
    expect(destinations({ to: t, data: '0xa9059cbb' + word(SPENDER) + word(5) })).toEqual([{ address: t, role: 'to' }, { address: SPENDER, role: 'recipient' }]);
    expect(destinations({ to: t, data: '0x39509351' + word(SPENDER) + word(5) })[1].role).toBe('spender');
    expect(destinations({ to: t, data: '0x095ea7b3' + 'ff'.repeat(32) + word(5) })).toEqual([{ address: t, role: 'to' }]); // not an address word
    expect(destinations({ to: t, data: '0x12345678' + word(SPENDER) })).toEqual([{ address: t, role: 'to' }]);
  });
  // ---- what the call data names: transferFrom, Permit2, batches ----
  const sel = (sig) => selector(sig);
  const hexOf = (d) => d.replace(/^0x/, '');
  const padBytes = (d) => { const h = hexOf(d); return word(h.length / 2) + h.padEnd(64 * Math.ceil(h.length / 64), '0'); };
  /** ABI of a bytes[] (its data part, without the head offset). */
  const bytesArrayData = (items) => {
    let off = 32 * items.length;
    const heads = [];
    const tails = [];
    for (const it of items) { heads.push(word(off)); const t = padBytes(it); tails.push(t); off += t.length / 2; }
    return word(items.length) + heads.join('') + tails.join('');
  };
  const multicall = (items) => '0x' + sel('multicall(bytes[])') + word(32) + bytesArrayData(items);
  const aggregate3 = (calls) => {
    let off = 32 * calls.length;
    const heads = [];
    const tails = [];
    for (const [target, data] of calls) { heads.push(word(off)); const t = word(target) + word(1) + word(96) + padBytes(data); tails.push(t); off += t.length / 2; }
    return '0x' + sel('aggregate3((address,bool,bytes)[])') + word(32) + word(calls.length) + heads.join('') + tails.join('');
  };
  const FROM = '0x' + '99'.repeat(20);
  const OTHER = '0x' + '8888888888888888888888888888888888888888'.slice(0, 40);
  const approveData = (who) => '0x095ea7b3' + word(who) + word(5);

  it('call data: transferFrom / safeTransferFrom recipient (2nd), Permit2 approve spender (2nd), setApprovalForAll operator; multicall and aggregate3 decoded; execute says inner calls not checked', async () => {
    const t = TARGET;
    expect(destinations({ to: t, data: '0x' + sel('transferFrom(address,address,uint256)') + word(FROM) + word(SPENDER) + word(5) }))
      .toEqual([{ address: t, role: 'to' }, { address: SPENDER, role: 'recipient' }]); // never the `from` (the user)
    expect(destinations({ to: t, data: '0x' + sel('safeTransferFrom(address,address,uint256,bytes)') + word(FROM) + word(SPENDER) + word(1) + word(128) + word(0) })[1])
      .toEqual({ address: SPENDER, role: 'recipient' });
    expect(destinations({ to: t, data: '0x' + sel('approve(address,address,uint160,uint48)') + word(IMPL) + word(SPENDER) + word(5) + word(9) }))
      .toEqual([{ address: t, role: 'to' }, { address: SPENDER, role: 'spender' }]);
    expect(destinations({ to: t, data: '0x' + sel('setApprovalForAll(address,bool)') + word(SPENDER) + word(1) })[1]).toEqual({ address: SPENDER, role: 'operator' });
    expect(analyzeCall({ to: t, data: multicall([approveData(SPENDER), '0xa9059cbb' + word(IMPL) + word(1)]) }))
      .toEqual({ destinations: [{ address: t, role: 'to' }, { address: SPENDER, role: 'spender' }, { address: IMPL, role: 'recipient' }], innerUnchecked: false });
    const deadline = '0x' + sel('multicall(uint256,bytes[])') + word(99) + word(64) + bytesArrayData([approveData(SPENDER)]);
    expect(destinations({ to: t, data: deadline })[1]).toEqual({ address: SPENDER, role: 'spender' });
    expect(analyzeCall({ to: t, data: aggregate3([[IMPL, approveData(SPENDER)]]) }))
      .toEqual({ destinations: [{ address: t, role: 'to' }, { address: IMPL, role: 'inner' }, { address: SPENDER, role: 'spender' }], innerUnchecked: false });
    expect(analyzeCall({ to: t, data: '0x' + sel('execute(bytes,bytes[])') + word(64) + word(96) + word(0) + word(0) }).innerUnchecked).toBe(true);
    expect(analyzeCall({ to: t, data: '0x' + sel('multicall(bytes[])') + word(32) + word(1000) }).innerUnchecked).toBe(true); // malformed: said so
  });

  it('a flagged spender inside a multicall is caught; an execute(...) batch says "inner calls not checked"', async () => {
    const snap = await installSnap(SNAP_ID);
    await useLocalRpc(snap);
    mockChain(snap, { codes: { [TARGET]: TARGET_CODE } });
    rpc.answers.clear();
    flag(56n, SPENDER, '0x', 'address', 6, true);
    let r = await inspect(snap, { to: TARGET, data: multicall(['0xa9059cbb' + word(IMPL) + word(1), approveData(SPENDER)]) });
    expect(r.severity).toBe('critical');
    expect(r.text).toContain(`ผู้ได้สิทธิ์ใช้เหรียญ (approve / permit) / Spender (approve / permit): ${SPENDER}`);
    rpc.answers.clear();
    flag(56n, OTHER, '0x', 'address', 1, true);
    r = await inspect(snap, { to: TARGET, data: '0x' + sel('transferFrom(address,address,uint256)') + word(FROM) + word(OTHER) + word(5) });
    expect(r.severity).toBe('critical');
    expect(r.text).toContain(`ผู้รับเหรียญ / Token recipient: ${OTHER}`);
    rpc.answers.clear();
    r = await inspect(snap, { to: TARGET, data: '0x' + sel('execute(bytes,bytes[])') + word(64) + word(96) + word(0) + word(0) });
    expect(r.text).toContain('no flag on what was checked');
    expect(r.text).toContain('inner calls not checked');
  });

  it('never switches the user\'s network: another chain in MetaMask means "couldn\'t check this chain" (an address flag still shows)', async () => {
    const snap = await installSnap(SNAP_ID);
    await useLocalRpc(snap);
    mockChain(snap, { codes: { [TARGET]: TARGET_CODE }, chain: '0x1' }); // MetaMask on Ethereum, the transaction on BSC
    rpc.answers.clear();
    switches.length = 0;
    let r = await inspect(snap, { to: TARGET });
    expect(r.text).toMatch(/couldn't check this transaction\ncouldn't check this chain: MetaMask's current network is eip155:1, this is eip155:56 \(the snap never switches networks\)/);
    flag(56n, TARGET, null, 'address', 1, true);
    r = await inspect(snap, { to: TARGET });
    expect(r.severity).toBe('critical');
    expect(switches).toEqual([]);
  });

  it('every insight says when a custom threat source is in use; the built-in one is not mentioned', async () => {
    const snap = await installSnap(SNAP_ID);
    mockChain(snap, { codes: { [TARGET]: TARGET_CODE } });
    expect((await inspect(snap, { to: TARGET })).text).not.toMatch(/custom threat source/);
    await useLocalRpc(snap);
    const note = `custom threat source in use (zetaphy_setThreatSource): RPC ${url}, ThreatRegistry ${REGISTRY}`;
    rpc.answers.clear();
    expect((await inspect(snap, { to: TARGET })).text).toContain(note); // clean
    flag(56n, TARGET, TARGET_CODE, 'address', 1, false);
    expect((await inspect(snap, { to: TARGET })).text).toContain(note); // warned
    flag(56n, TARGET, TARGET_CODE, 'address', 1, true);
    expect((await inspect(snap, { to: TARGET })).text).toContain(note); // enforced
    rpc.status = 500;
    expect((await inspect(snap, { to: TARGET })).text).toContain(note); // unchecked
    rpc.status = 200;
  });

  it('responses: each shown with its author; the governance-assigned responder\'s first', async () => {
    const snap = await installSnap(SNAP_ID);
    await useLocalRpc(snap);
    mockChain(snap, { codes: { [TARGET]: TARGET_CODE } });
    rpc.answers.clear();
    flag(56n, TARGET, TARGET_CODE, 'address', 3, true);
    const key = addressKey(56n, TARGET);
    const GOVR = '0x' + '0b'.repeat(20);
    const OWNER = '0x' + '0a'.repeat(20);
    rpc.answers.set(detailQueries(key).responses[0], responseAnswer('the assigned responder speaks', GOVR, 0));
    rpc.answers.set(detailQueries(key).responses[1], responseAnswer('the owner speaks', OWNER));
    const r = await inspect(snap, { to: TARGET });
    const assigned = r.text.indexOf(`response from the governance-assigned responder (${GOVR}): "the assigned responder speaks"`);
    const owner = r.text.indexOf(`response from ${OWNER} (สำหรับ / for 56:${TARGET}): "the owner speaks"`);
    expect(assigned).toBeGreaterThan(-1);
    expect(owner).toBeGreaterThan(assigned);
  });

  // ---- signature insight: EIP-712 Permit, Permit2, Seaport-style orders ----
  const USER = '0x' + '99'.repeat(20);
  const sign = (snap, data, signatureMethod = 'eth_signTypedData_v4') => snap.onSignature({ from: USER, data, signatureMethod });
  async function inspectSig(snap, data, method) {
    const res = await sign(snap, data, method);
    expect(res.response.error).toBeUndefined();
    const ui = await res.getInterface();
    return { severity: res.response.result?.severity ?? null, text: linesOf(ui.content).join('\n') };
  }
  const permit = (chainId = 56) => ({ types: {}, primaryType: 'Permit', domain: { name: 'Token', version: '1', chainId, verifyingContract: TARGET },
    message: { owner: USER, spender: SPENDER, value: '1000', nonce: 0, deadline: 9999999999 } });

  it('signatures: a flagged Permit spender is critical; Permit2 and Seaport zone / recipients are checked; the signer is never sent', async () => {
    const snap = await installSnap(SNAP_ID);
    await useLocalRpc(snap);
    mockChain(snap, { codes: { [TARGET]: TARGET_CODE } });
    rpc.answers.clear();
    rpc.requests.length = 0;
    flag(56n, SPENDER, '0x', 'address', 6, true);
    let r = await inspectSig(snap, permit());
    expect(r.severity).toBe('critical');
    expect(r.text).toContain(`ผู้ได้สิทธิ์ใช้เหรียญ (approve / permit) / Spender (approve / permit): ${SPENDER}`);
    expect(r.text).toContain('an address this signature involves');
    expect(JSON.stringify(rpc.requests)).not.toContain('99'.repeat(20));
    // Permit2 (PermitSingle), as a JSON string with a hex chain id: flagged, not enforced -> a warning.
    rpc.answers.clear();
    flag(56n, SPENDER, '0x', 'address', 6, false);
    const permit2 = { types: {}, primaryType: 'PermitSingle', domain: { name: 'Permit2', chainId: '0x38', verifyingContract: IMPL },
      message: { details: { token: TARGET, amount: '1', expiration: 1, nonce: 0 }, spender: SPENDER, sigDeadline: 1 } };
    r = await inspectSig(snap, permit2, 'eth_signTypedData_v3');
    expect(typedDataTargets({ signatureMethod: 'eth_signTypedData_v4', from: USER, data: JSON.stringify(permit2) })) // a JSON string is read too
      .toEqual({ chainId: 56n, destinations: [{ address: IMPL, role: 'verifying' }, { address: SPENDER, role: 'spender' }] });
    expect(r.severity).toBeNull();
    expect(r.text).toContain('Warning from ZETAPHY Neuro');
    // A Seaport-style order: zone and the recipients other than the offerer.
    rpc.answers.clear();
    rpc.requests.length = 0;
    const order = { types: {}, primaryType: 'OrderComponents', domain: { name: 'Seaport', chainId: 56, verifyingContract: TARGET },
      message: { offerer: USER, zone: BEACON, offer: [], consideration: [{ recipient: USER }, { recipient: OTHER }] } };
    r = await inspectSig(snap, order);
    expect(r.text).toContain('no flag on what was checked');
    expect(r.text).toContain(`zone ของคำสั่งซื้อขาย / Order zone: ${BEACON}`);
    expect(r.text).toContain(`ตรวจแล้ว / checked: ผู้รับเหรียญ / Token recipient: ${OTHER}`);
    expect(r.text).toContain(`สัญญาที่ลายเซ็นนี้ใช้กับ / Contract this signature is for: ${TARGET}`);
    expect(r.text).toContain('Only checked: the contract this signature is for and the spender, operator, zone or recipients it names');
    expect(JSON.stringify(rpc.requests)).not.toContain('99'.repeat(20));
    expect(typedDataTargets({ signatureMethod: 'eth_signTypedData_v4', from: USER, data: order }).destinations.map((d) => d.role)).toEqual(['verifying', 'zone', 'recipient']);
  });

  it('signatures: personal_sign has no insight; typed data without a chain, or on another chain than MetaMask\'s, says why it could not check (no switch)', async () => {
    const snap = await installSnap(SNAP_ID);
    await useLocalRpc(snap);
    mockChain(snap, { codes: { [TARGET]: TARGET_CODE } });
    switches.length = 0;
    // (snaps-jest expects an interface from onSignature, so this one calls the snap's code directly.)
    expect(typedDataTargets({ signatureMethod: 'personal_sign', from: USER, data: '0x68656c6c6f' })).toBeNull();
    expect(typedDataTargets({ signatureMethod: 'eth_signTypedData', from: USER, data: [{ type: 'string', name: 'm', value: 'hi' }] })).toBeNull();
    expect(await checkSignature({ signature: { signatureMethod: 'personal_sign', from: USER, data: '0x68656c6c6f' } }, { rpc: url, registry: REGISTRY })).toBeNull();
    const noChain = permit();
    delete noChain.domain.chainId;
    let r = await inspectSig(snap, noChain);
    expect(r.text).toMatch(/couldn't check this signature\nthe typed data names no chain \(domain.chainId\)/);
    rpc.answers.clear();
    r = await inspectSig(snap, permit(1));
    expect(r.text).toMatch(/couldn't check this signature\ncouldn't check this chain: MetaMask's current network is eip155:56, this is eip155:1/);
    expect(switches).toEqual([]);
  });
});
