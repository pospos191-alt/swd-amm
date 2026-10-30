// Unit tests of the validators (deep), governance, holders, NFT, gas, tools and PWA
// modules: uptime from commit signatures, the Nakamoto coefficient, the x/gov tally rule,
// holder balances rebuilt from Transfer logs, the NFT metadata sanitiser and URL
// allow-list, RLP decoding and sender recovery against ethers, eth_feeHistory
// percentiles, and static checks of the manifest, service worker and CSP.
//   node --test test/explore2.unit.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { Wallet, Transaction, AbiCoder, hashMessage } from 'ethers';
import { ml_dsa44, bytesToHex, keccak_256 } from '../vendor/zetaphy-lib.js';
import { buildChain, ME, ME_HEX, TOKEN, TOKEN_OWNER, NFT_META_7, NFT_META_8 } from './mock-chain.js';
import {
  commitFlag, parseWindowBlock, uptime, certInclusion, nakamoto, filterRows, sortRows, valcons, valconsToHex, slashEvents, decNum, loadWindow,
} from '../src/validators2.js';
import { tallySummary, parseDec, countdown, proposalRequestHex, decodeProposalProto, normTally, flattenJson, pct } from '../src/gov.js';
import { logWindows, rebuildBalances, pickCandidates, distribution, ownerFlag, scanTransfers, MAX_WINDOWS, RANGE } from '../src/holders.js';
import {
  resolveUri, decodeDataUri, sanitizeMetadata, imageSource, svgDataUri, fillIdTemplate, abiStringRaw, gatewayBase, metaText, loadMetadata, MAX_META_BYTES,
} from '../src/nft.js';
import { feeSuggestions, median, burnedEstimate, actionCosts } from '../src/gas.js';
import {
  decodeSignedTx, rlpEncode, bigBytes, recoverPersonal, personalHash, verifyMlDsa, parseAmount, convertUnits, convertAddress, revertReason, parseBytes,
} from '../src/tools.js';
import { rlpDecode } from '../src/evm.js';
import { sanitizeConfig, DEFAULTS } from '../src/config.js';
import { fromBase64 } from '../src/format.js';

const ROOT = new URL('..', import.meta.url);
const read = (p) => readFileSync(new URL(p, ROOT), 'utf8');
const chain = buildChain();
const coder = AbiCoder.defaultAbiCoder();
const E18 = 10n ** 18n;

// ---------------- validators ----------------

test('commitFlag: numbers and names', () => {
  assert.equal(commitFlag({ block_id_flag: 2 }), 'commit');
  assert.equal(commitFlag({ block_id_flag: 'BLOCK_ID_FLAG_COMMIT' }), 'commit');
  assert.equal(commitFlag({ block_id_flag: 3 }), 'nil');
  assert.equal(commitFlag({ block_id_flag: 1 }), 'absent');
  assert.equal(commitFlag({}), 'absent');
});

test('uptime and PQ certificate inclusion from the commit signatures of real (mock) blocks', () => {
  const entries = [];
  for (let b = 2; b <= 30; b++) entries.push(parseWindowBlock(chain.comet('block', { height: String(b) })));
  const [alpha, beta] = chain.vals;
  const ua = uptime(entries, alpha.address);
  assert.equal(ua.signed, 29); assert.equal(ua.missed, 0); assert.equal(ua.pct, 100);
  const ub = uptime(entries, beta.address.toLowerCase()); // case-insensitive
  assert.equal(ub.total, 29); assert.equal(ub.missed, 5); // heights 5, 10, 15, 20, 25
  assert.equal(ub.pct, Math.round((24 / 29) * 10000) / 100);
  assert.deepEqual(ub.strip.filter((x) => x.state === 'missed').map((x) => x.height), [5, 10, 15, 20, 25]);
  assert.deepEqual(ub.strip.map((x) => x.height), Array.from({ length: 29 }, (_, i) => i + 1)); // oldest first
  // not in the set at all: nothing counted
  const none = uptime(entries, 'AB'.repeat(20));
  assert.equal(none.pct, null); assert.equal(none.out, 29);
  // nil votes count as missed
  const nil = uptime([{ height: 9, hasCommit: true, sigs: new Map([['AA', 'nil']]), certSigners: null }], 'aa');
  assert.equal(nil.nil, 1); assert.equal(nil.pct, 0);
  // certificates: tx 0 of blocks 3..30 certify 2..29, all signed by Alpha only
  assert.deepEqual(certInclusion(entries, alpha.address), { included: 28, certs: 28 });
  assert.deepEqual(certInclusion(entries, beta.address), { included: 0, certs: 28 });
});

test('loadWindow reads each block once (cached) and reports progress', async () => {
  let calls = 0; const seen = [];
  const fake = { block: async (h) => { calls++; return chain.comet('block', { height: String(h) }); } };
  const w = await loadWindow(fake, 30, 10, (d, n) => seen.push([d, n]));
  assert.equal(w.entries.length, 10); assert.equal(w.from, 20); assert.equal(w.to, 29);
  assert.equal(calls, 10); assert.deepEqual(seen.at(-1), [10, 10]);
  await loadWindow(fake, 30, 10);
  assert.equal(calls, 10, 'parsed blocks are kept');
});

test('Nakamoto coefficient: fewest validators with at least 1/3 of the power', () => {
  assert.equal(nakamoto([60n, 40n]), 1);
  assert.equal(nakamoto([10, 10, 10, 10, 10, 10]), 2);
  assert.equal(nakamoto([1, 1, 1]), 1);
  assert.equal(nakamoto([25, 25, 25, 25]), 2);
  assert.equal(nakamoto(['5', '30', '20', '20', '25']), 2); // sorted: 30 + 25 = 55 ≥ 33.3
  assert.equal(nakamoto([]), 0);
  assert.equal(nakamoto([0n, 0n]), 0);
});

test('validator list: filter, sort, valcons, slash events', () => {
  const rows = [
    { moniker: 'Alpha', operator: 'zetaphyvaloper1a', address: 'AA', power: 60n, active: true, jailed: false, commission: '0.05', voteKey: { registered: true } },
    { moniker: 'Beta', operator: 'zetaphyvaloper1b', address: 'BB', power: 40n, active: true, jailed: false, commission: '0.10', voteKey: { registered: false } },
    { moniker: 'Gamma', operator: 'zetaphyvaloper1c', address: 'CC', power: 0n, active: false, jailed: true, commission: '0.01' },
  ];
  assert.deepEqual(filterRows(rows, { status: 'jailed' }).map((r) => r.moniker), ['Gamma']);
  assert.deepEqual(filterRows(rows, { status: 'active', q: 'bet' }).map((r) => r.moniker), ['Beta']);
  assert.deepEqual(filterRows(rows, { status: 'inactive' }).map((r) => r.moniker), []);
  assert.deepEqual(sortRows(rows, 'commission', 1).map((r) => r.moniker), ['Gamma', 'Alpha', 'Beta']);
  assert.deepEqual(sortRows(rows, 'moniker', -1).map((r) => r.moniker), ['Gamma', 'Beta', 'Alpha']);
  const up = new Map([['AA', { pct: 90 }], ['BB', { pct: 99 }]]);
  assert.deepEqual(sortRows(rows, 'uptime', -1, up).map((r) => r.moniker), ['Beta', 'Alpha', 'Gamma']);
  assert.equal(decNum('0.050000000000000000'), 0.05); assert.ok(Number.isNaN(decNum('x')));
  const vc = valcons(chain.vals[1].address);
  assert.equal(vc, chain.valconsOf(chain.vals[1]));
  assert.equal(valconsToHex(vc), chain.vals[1].address);
  assert.equal(valcons('zz'), '');
  const ev = slashEvents(chain.comet('block_results', { height: '12' }));
  assert.deepEqual(ev.map((e) => [e.address, e.reason, e.power]), [[vc, 'missing_signature', '40']]);
  assert.deepEqual(slashEvents(null), []);
});

// ---------------- governance ----------------

test('gov tally: quorum, threshold, veto, abstain (x/gov v1 rule)', () => {
  const params = { quorum: '0.334000000000000000', threshold: '0.500000000000000000', vetoThreshold: '0.334000000000000000' };
  const bonded = 10n ** 23n;
  const s = tallySummary({ yes: 3n * 10n ** 22n, no: 10n ** 22n, abstain: 5n * 10n ** 21n, veto: 0n }, bonded, params);
  assert.equal(s.voted, 45n * 10n ** 21n);
  assert.deepEqual(s.percents, { yes: 66.66, no: 22.22, abstain: 11.11, veto: 0 });
  assert.equal(s.turnout, 45); assert.equal(s.quorumReached, true); assert.equal(s.yesShare, 75); assert.equal(s.passing, true); assert.equal(s.vetoed, false);
  // below quorum (33 % < 33.4 %)
  assert.equal(tallySummary({ yes: 33n * 10n ** 21n }, bonded, params).quorumReached, false);
  assert.equal(tallySummary({ yes: 33n * 10n ** 21n }, bonded, params).passing, false);
  // veto above 1/3 of the votes
  const v = tallySummary({ yes: 60n, veto: 40n }, 100n, params);
  assert.equal(v.vetoed, true); assert.equal(v.passing, false);
  // exactly the threshold is not enough (strictly greater)
  assert.equal(tallySummary({ yes: 50n, no: 50n }, 100n, params).passing, false);
  // everyone abstains: fails
  assert.equal(tallySummary({ abstain: 100n }, 100n, params).passing, false);
  // REST names
  assert.deepEqual(normTally({ yes_count: '1', no_count: '2', abstain_count: '3', no_with_veto_count: '4' }), { yes: '1', no: '2', abstain: '3', veto: '4' });
  assert.deepEqual(normTally({ yes: '9' }), { yes: '9', no: '0', abstain: '0', veto: '0' });
  assert.equal(parseDec('0.334000000000000000'), 334n * 10n ** 15n);
  assert.equal(parseDec('1'), E18); assert.equal(parseDec('nope'), null);
  assert.equal(pct(1n, 3n), 33.33); assert.equal(pct(1n, 0n), 0);
});

test('gov: countdown, proposal request bytes, protobuf proposal decoded with the explorer\'s decoder, JSON fallback bounded', () => {
  const now = Date.parse('2026-10-30T00:00:00Z');
  assert.deepEqual(countdown('2026-11-01T03:04:05Z', now), { d: 2, h: 3, m: 4, s: 5, done: false });
  assert.equal(countdown('2026-10-29T00:00:00Z', now).done, true);
  assert.equal(countdown('bad', now).done, true);
  assert.equal(proposalRequestHex(2), '0802');
  assert.equal(proposalRequestHex(300), '08ac02');
  const r = chain.comet('abci_query', { path: '/cosmos.gov.v1.Query/Proposal', data: proposalRequestHex(2) });
  const outer = fromBase64(r.response.value);
  // QueryProposalResponse { proposal = 1 }: one length-delimited field
  assert.equal(outer[0], 0x0a);
  const d = decodeProposalProto(outer.subarray(outer[1] < 0x80 ? 2 : 3));
  assert.equal(d.id, 2n); assert.equal(d.status, 'PROPOSAL_STATUS_VOTING_PERIOD');
  assert.equal(d.messages[0].name, 'MsgSend');
  assert.equal(d.messages[0].fields.find((f) => f.name === 'to').value, ME);
  const flat = flattenJson({ '@type': 'x', a: { b: { c: 'v‮' } }, list: Array.from({ length: 100 }, (_, i) => i) });
  assert.deepEqual(flat[0], ['a.b.c', 'v']);
  assert.ok(flat.length <= 40);
});

// ---------------- holders ----------------

test('holders: 500-block windows, balances rebuilt from Transfer logs, top holders confirmed, concentration and owner flag', async () => {
  assert.deepEqual(logWindows(1, 1200), [[701, 1200], [201, 700], [1, 200]]);
  assert.deepEqual(logWindows(5, 5), [[5, 5]]);
  assert.ok(logWindows(1, 100000).every(([lo, hi]) => hi - lo + 1 <= RANGE));
  const logs = chain.evmRpc('eth_getLogs', [{ fromBlock: '0x1', toBlock: '0x1e', address: TOKEN }]);
  const rb = rebuildBalances([...logs, ...chain.evmRpc('eth_getLogs', [{ fromBlock: '0x1', toBlock: '0x1e' }])], TOKEN); // other contracts' logs ignored
  assert.equal(rb.transfers, 3);
  assert.equal(rb.net.get(TOKEN_OWNER), 899900n * E18);
  assert.equal(rb.net.get(chain.evmWallet.address.toLowerCase()), 985n * 10n ** 17n);
  assert.equal(rb.net.get(ME_HEX.toLowerCase()), 15n * 10n ** 17n);
  assert.deepEqual(rb.firstMint, { to: TOKEN_OWNER, block: 5 });
  assert.equal(rb.minted, 900000n * E18);
  const cands = pickCandidates(rb.net, 10, [TOKEN_OWNER]);
  assert.deepEqual(cands, [TOKEN_OWNER, chain.evmWallet.address.toLowerCase(), ME_HEX.toLowerCase()]);
  const holders = cands.map((a) => ({ address: a, balance: BigInt(chain.evmRpc('eth_call', [{ to: TOKEN, data: '0x70a08231' + a.slice(2).padStart(64, '0') }])) }));
  const dist = distribution(holders, 10n ** 24n, 25);
  assert.equal(dist.top[0].address, TOKEN_OWNER); assert.equal(dist.top[0].share, 89.99);
  assert.equal(dist.top10Share, 90);
  assert.equal(ownerFlag(dist, TOKEN_OWNER), 'most');
  assert.equal(ownerFlag(distribution([{ address: 'a', balance: 40n }, { address: 'b', balance: 30n }], 100n), 'a'), 'top');
  assert.equal(ownerFlag(dist, ME_HEX.toLowerCase()), null);
  assert.equal(ownerFlag(dist, null), null);
  // the scan: never more than 500 blocks per eth_getLogs, at most MAX_WINDOWS calls
  const ranges = [];
  const fakeEvm = async (m, [f]) => { ranges.push([Number(BigInt(f.fromBlock)), Number(BigInt(f.toBlock))]); assert.equal(f.address, TOKEN); return []; };
  const r = await scanTransfers(fakeEvm, TOKEN, 1, 100000);
  assert.equal(ranges.length, MAX_WINDOWS);
  assert.ok(ranges.every(([lo, hi]) => hi - lo + 1 <= RANGE));
  assert.equal(r.from, 100000 - MAX_WINDOWS * RANGE + 1); // the page says the window was cut
});

// ---------------- NFT ----------------

test('NFT: URI resolution and the image allow-list', () => {
  const g = 'https://ipfs.io';
  assert.deepEqual(resolveUri('ipfs://QmA/1.json', g), { kind: 'ipfs', url: 'https://ipfs.io/ipfs/QmA/1.json' });
  assert.deepEqual(resolveUri('ipfs://ipfs/QmA', 'https://gw.example/'), { kind: 'ipfs', url: 'https://gw.example/ipfs/QmA' });
  assert.deepEqual(resolveUri('http://x.example/a.json', g), { kind: 'https', url: 'https://x.example/a.json' });
  assert.equal(resolveUri('https://u:p@x.example/', g), null);
  for (const bad of ['javascript:alert(1)', 'file:///etc/passwd', 'ar://abc', '/relative.json', '', 'ftp://x/y', 'ipfs://Qm"onerror']) assert.equal(resolveUri(bad, g), null, bad);
  assert.equal(gatewayBase('http://evil.example'), 'https://ipfs.io');
  assert.equal(gatewayBase('https://gw.example/sub/'), 'https://gw.example/sub');
  // images: https, ipfs and data:image only
  assert.equal(imageSource('data:image/png;base64,iVBORw0KGgo=', g).kind, 'data');
  assert.equal(imageSource('data:image/svg+xml;base64,PHN2Zy8+', g).kind, 'data');
  for (const bad of ['data:text/html;base64,PHNjcmlwdD4=', 'data:image/x-icon2,abc', 'javascript:1', 'data:application/javascript,alert(1)']) assert.equal(imageSource(bad, g), null, bad);
  assert.equal(imageSource('ipfs://QmImg', g).url, 'https://ipfs.io/ipfs/QmImg');
  assert.equal(fillIdTemplate('https://x/{id}.json', 255), `https://x/${'0'.repeat(62)}ff.json`);
});

test('NFT: metadata sanitiser (text only, no tags, https links, SVG as an <img> data URI) and bounded loading', async () => {
  const m = sanitizeMetadata(NFT_META_7, 'https://ipfs.io');
  assert.equal(m.name, 'Siam Temple #7');
  assert.equal(m.description, 'window.__pwned=2 Sunrise over Wat Arun'); // tags stripped, bidi removed, never markup
  assert.equal(m.externalUrl, null); // javascript: dropped
  assert.deepEqual(m.image, { kind: 'ipfs', url: 'https://ipfs.io/ipfs/bafyimg7/7.png' });
  assert.deepEqual(m.attributes, [{ trait: 'Colour', value: 'Gold' }, { trait: 'Rarity', value: 'Rare' }]);
  const m8 = sanitizeMetadata(NFT_META_8);
  assert.equal(m8.externalUrl, 'https://siam.art/8');
  assert.match(m8.image.url, /^data:image\/svg\+xml;base64,/);
  const raw = sanitizeMetadata({ image_data: '<svg onload="x()"/>', attributes: { a: { b: 1 } } });
  assert.equal(raw.image.url, svgDataUri('<svg onload="x()"/>'));
  assert.deepEqual(raw.attributes, [{ trait: 'a', value: '{"b":1}' }]);
  assert.deepEqual(sanitizeMetadata(null).attributes, []);
  assert.equal(sanitizeMetadata({ attributes: Array.from({ length: 80 }, (_, i) => ({ trait_type: `t${i}`, value: i })) }).attributes.length, 50);
  assert.equal(metaText('<b>x</b>‮​ y'), 'x y');
  // data: URIs
  const j = 'data:application/json;base64,' + Buffer.from('{"name":"a"}').toString('base64');
  assert.deepEqual(await loadMetadata(resolveUri(j)), { name: 'a' });
  assert.deepEqual(await loadMetadata(resolveUri('data:application/json,%7B%22n%22%3A1%7D')), { n: 1 });
  assert.equal(decodeDataUri('not data'), null);
  assert.equal(decodeDataUri('data:application/json;base64,' + 'A'.repeat(MAX_META_BYTES * 2)), null);
  // fetched metadata: no cookies, size bounded
  let init = null;
  const ok = await loadMetadata({ kind: 'https', url: 'https://x/1' }, async (u, i) => { init = i; return new Response('{"x":1}', { headers: { 'content-length': '7' } }); });
  assert.deepEqual(ok, { x: 1 }); assert.equal(init.credentials, 'omit'); assert.equal(init.referrerPolicy, 'no-referrer');
  await assert.rejects(loadMetadata({ kind: 'https', url: 'https://x/1' }, async () => new Response('{}', { headers: { 'content-length': String(MAX_META_BYTES + 1) } })), /too large/);
  await assert.rejects(loadMetadata(null), /unsupported/);
  // tokenURI strings (unsanitised for parsing, bounded)
  assert.equal(abiStringRaw(coder.encode(['string'], ['ipfs://QmX/1'])), 'ipfs://QmX/1');
  assert.equal(abiStringRaw('0x1234'), null);
});

// ---------------- gas ----------------

test('gas: feeHistory percentiles (median of non-empty blocks), next base fee, burned estimate, action costs', () => {
  const hist = {
    oldestBlock: '0x64', baseFeePerGas: ['0x3b9aca00', '0x3b9aca00', '0x77359400', '0x77359400'], gasUsedRatio: [0.5, 0, 1],
    reward: [['0x1', '0xa', '0x64'], ['0x0', '0x0', '0x0'], ['0x3', '0x1e', '0x12c']],
  };
  const f = feeSuggestions(hist);
  assert.equal(f.baseFee, 2n * 10n ** 9n); // the next block's
  assert.equal(f.blocks.length, 3); assert.equal(f.blocks[0].number, 100);
  assert.equal(f.slow.tip, 1n); assert.equal(f.normal.tip, 10n); assert.equal(f.fast.tip, 100n); // lower median of [1, 3], [10, 30], [100, 300]
  assert.equal(f.fast.price, 2n * 10n ** 9n + 100n);
  assert.equal(f.fast.maxFee, 4n * 10n ** 9n + 100n);
  assert.equal(feeSuggestions({ baseFeePerGas: ['0x5'], gasUsedRatio: [], reward: [] }, 7n).normal.tip, 7n); // no blocks: fallback tip
  assert.equal(median([5n, 1n, 3n]), 3n); assert.equal(median([]), null);
  // burned: Σ base × ratio × limit = 1e9 × 0.5 × 1e6 + 0 + 2e9 × 1 × 1e6
  assert.equal(burnedEstimate(hist, 1000000n), 5n * 10n ** 14n + 2n * 10n ** 15n);
  const costs = actionCosts(10n ** 9n);
  assert.deepEqual(costs[0], { key: 'gasActTransfer', gas: 21000n, cost: 21000n * 10n ** 9n });
  // against the mock node: same numbers the page shows
  const mh = chain.evmRpc('eth_feeHistory', ['0x14', 'latest', [10, 50, 90]]);
  const mf = feeSuggestions(mh);
  assert.equal(mf.baseFee, chain.baseFeeAt(31));
  assert.ok(mf.slow.tip <= mf.normal.tip && mf.normal.tip <= mf.fast.tip);
});

// ---------------- tools ----------------

test('tools: RLP encode is the inverse of decode', () => {
  for (const x of [new Uint8Array(), Uint8Array.of(0x7f), Uint8Array.of(0x80), new Uint8Array(55).fill(1), new Uint8Array(56).fill(2), new Uint8Array(1024).fill(3),
    [], [Uint8Array.of(1), [Uint8Array.of(2), []]], Array.from({ length: 30 }, () => new Uint8Array(3).fill(9))]) {
    assert.deepEqual(rlpDecode(rlpEncode(x)), x);
  }
  assert.equal(bytesToHex(rlpEncode(new TextEncoder().encode('dog'))), '83646f67');
  assert.equal(bytesToHex(bigBytes(0n)), ''); assert.equal(bytesToHex(bigBytes(1024n)), '0400');
});

test('tools: signed tx decode (legacy, EIP-155, EIP-2930, EIP-1559) and sender recovery match ethers', async () => {
  const w = new Wallet('0x' + '42'.repeat(32));
  const txs = [
    { type: 0, chainId: 77390, nonce: 7, gasPrice: 10n ** 9n, gasLimit: 21000n, to: '0x' + '11'.repeat(20), value: 5n * E18 },
    { type: 0, chainId: 0, nonce: 0, gasPrice: 1n, gasLimit: 21000n, to: '0x' + '11'.repeat(20), value: 1n }, // pre-EIP-155
    { type: 1, chainId: 77390, nonce: 2, gasPrice: 3n, gasLimit: 90000n, to: null, data: '0x6000600055', accessList: [{ address: '0x' + '33'.repeat(20), storageKeys: ['0x' + '00'.repeat(31) + '01'] }] },
    { type: 2, chainId: 77390, nonce: 300, maxFeePerGas: 2n * 10n ** 9n, maxPriorityFeePerGas: 10n ** 9n, gasLimit: 65000n, to: TOKEN, data: '0xa9059cbb' + '00'.repeat(64) },
    { type: 2, chainId: 1, nonce: 1, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n, gasLimit: 21000n, to: ME_HEX, value: 0n },
  ];
  for (const tx of txs) {
    const raw = await w.signTransaction(tx);
    const e = Transaction.from(raw);
    const d = decodeSignedTx(raw);
    assert.equal(d.type, e.type);
    assert.equal(d.from, w.address, `type ${tx.type}`);
    assert.equal(d.hash, e.hash);
    assert.equal(d.signingHash, e.unsignedHash);
    assert.equal(d.nonce, BigInt(e.nonce)); assert.equal(d.gas, e.gasLimit); assert.equal(d.value, e.value);
    assert.equal(d.to, e.to);
    assert.equal(d.data, e.data);
    assert.equal(d.chainId, tx.chainId === 0 ? null : e.chainId);
    if (tx.type === 2) { assert.equal(d.maxFeePerGas, e.maxFeePerGas); assert.equal(d.maxPriorityFeePerGas, e.maxPriorityFeePerGas); } else assert.equal(d.gasPrice, e.gasPrice);
    if (tx.type === 1) assert.deepEqual(d.accessList, [{ address: '0x' + '33'.repeat(20), storageKeys: ['0x' + '00'.repeat(31) + '01'] }]);
    assert.equal(d.highS, false);
    // also as base64
    assert.equal(decodeSignedTx(Buffer.from(raw.slice(2), 'hex').toString('base64')).from, w.address);
  }
  assert.throws(() => decodeSignedTx('0x03c0'), /type 3/);
  assert.throws(() => decodeSignedTx('0xc0'), /expected 9 fields/);
  assert.throws(() => decodeSignedTx('zz'), /hex or base64/);
  assert.throws(() => decodeSignedTx('0x'), /empty/);
});

test('tools: personal_sign recovery, ML-DSA-44 verification, units, addresses, revert reasons', async () => {
  const w = new Wallet('0x' + '42'.repeat(32));
  const sig = await w.signMessage('hello ZETAPHY');
  assert.equal(bytesToHex(personalHash('hello ZETAPHY')), hashMessage('hello ZETAPHY').slice(2));
  assert.equal(recoverPersonal('hello ZETAPHY', sig), w.address);
  assert.notEqual(recoverPersonal('hello zetaphy', sig), w.address);
  const bytes = Uint8Array.of(1, 2, 3);
  assert.equal(recoverPersonal(bytes, await w.signMessage(bytes)), w.address);
  assert.throws(() => recoverPersonal('x', '0x1234'), /65 bytes/);
  // ML-DSA-44 (the certificate verifier's library)
  const kp = ml_dsa44.keygen(new Uint8Array(32).fill(5));
  const msg = new TextEncoder().encode('block 7');
  const s = ml_dsa44.sign(msg, kp.secretKey);
  assert.equal(verifyMlDsa('0x' + bytesToHex(kp.publicKey), 'block 7', '0x' + bytesToHex(s)), true);
  assert.equal(verifyMlDsa(Buffer.from(kp.publicKey).toString('base64'), msg, Buffer.from(s).toString('base64')), true);
  s[3] ^= 1;
  assert.equal(verifyMlDsa(kp.publicKey, msg, s), false);
  assert.throws(() => verifyMlDsa('0x00', msg, s), /1312/);
  // units
  assert.equal(parseAmount('1.5', 'zetaphy'), 15n * 10n ** 17n);
  assert.equal(parseAmount('2', 'gwei'), 2n * 10n ** 9n);
  assert.equal(parseAmount('1,000', 'azeta'), 1000n);
  assert.throws(() => parseAmount('0.5', 'azeta'), /decimals/);
  assert.throws(() => parseAmount('-1'), /number/);
  assert.deepEqual(convertUnits(15n * 10n ** 17n), { azeta: '1,500,000,000,000,000,000', gwei: '1,500,000,000', zetaphy: '1.5' });
  // addresses: one 20-byte value in three spellings
  const a = convertAddress(ME);
  assert.equal(a.hex, ME_HEX);
  assert.deepEqual(convertAddress(a.valoper), a);
  assert.equal(convertAddress('nope'), null);
  // revert data
  const err = '0x08c379a0' + coder.encode(['string'], ['not enough']).slice(2);
  assert.equal(revertReason(err), 'not enough');
  assert.equal(revertReason('0x4e487b71' + '0'.repeat(62) + '11'), 'panic 0x11');
  assert.deepEqual(parseBytes('0x0102'), Uint8Array.of(1, 2));
});

// ---------------- config, PWA, CSP ----------------

test('config: IPFS gateway https only, hub governance link', () => {
  assert.equal(DEFAULTS.ipfsGateway, 'https://ipfs.io');
  assert.equal(sanitizeConfig({ ipfsGateway: 'https://gw.example/' }).ipfsGateway, 'https://gw.example');
  assert.equal(sanitizeConfig({ ipfsGateway: 'http://gw.example' }).ipfsGateway, 'https://ipfs.io');
  assert.equal(sanitizeConfig({ hubGovUrl: 'javascript:alert(1)' }).hubGovUrl, DEFAULTS.hubGovUrl);
  assert.equal(sanitizeConfig({ hubGovUrl: '' }).hubGovUrl, '');
});

test('PWA: manifest, service worker (shell only, never node answers), CSP and headers', () => {
  const m = JSON.parse(read('manifest.webmanifest'));
  assert.equal(m.name, 'ZETAPHY Explorer'); assert.equal(m.display, 'standalone'); assert.equal(m.start_url, './#/'); assert.equal(m.scope, './');
  for (const i of m.icons) assert.ok(existsSync(new URL(i.src, ROOT)), i.src);
  assert.ok(m.icons.some((i) => i.sizes === '512x512') && m.icons.some((i) => i.sizes === '192x192'));
  const html = read('index.html');
  assert.match(html, /<link rel="manifest" href="manifest\.webmanifest">/);
  const sw = read('sw.js');
  assert.match(sw, /url\.origin !== self\.location\.origin\) return null/); // other hosts (the node) never handled
  assert.match(sw, /req\.method !== 'GET'/);
  const shellPath = new Function(`${/const SHELL_PATH = (.*);/.exec(sw)[0]} return SHELL_PATH;`)(); // eslint-disable-line no-new-func
  for (const p of ['', 'index.html', 'src/app.js', 'src/gov.js', 'vendor/zetaphy-lib.js', 'style.css', 'manifest.webmanifest']) assert.ok(shellPath.test(p), p);
  for (const p of ['config.json', 'rest/cosmos/x', 'rpc/', 'sw.js', 'test/unit.test.js', '../x.js']) assert.ok(!shellPath.test(p), p);
  const shell = JSON.parse(`[${/const SHELL = \[([\s\S]*?)\];/.exec(sw)[1].replaceAll('\'', '"').replace(/,\s*$/, '')}]`);
  for (const f of shell) assert.ok(existsSync(new URL(f, ROOT)), f);
  assert.ok(!shell.includes('config.json'));
  assert.match(read('src/pwa.js'), /win\.top !== win/); // not inside the hub's frame
  const v = JSON.parse(read('vercel.json'));
  const csp = v.headers[0].headers.find((x) => x.key === 'Content-Security-Policy').value;
  assert.match(csp, /worker-src 'self'/);
  assert.match(csp, /manifest-src 'self'/);
  assert.match(csp, /img-src 'self' data: blob: https:\/\/ipfs\.io;/); // images: own, data:, blob: (fetched on request), the IPFS gateway; no other host
  assert.match(csp, /connect-src 'self' https: https:\/\/ipfs\.io( wss:\/\/[a-z0-9.-]+)?;/); // + the live websocket of config.json's node (unit.test.js)
  assert.ok(!/script-src[^;]*(blob:|data:|https:)/.test(csp), 'scripts only from this site');
  const swHeaders = v.headers.find((x) => x.source === '/sw.js').headers;
  assert.ok(swHeaders.some((x) => x.key === 'Cache-Control' && /no-cache/.test(x.value)));
  assert.equal(v.headers.find((x) => x.source === '/manifest.webmanifest').headers.find((x) => x.key === 'Content-Type').value, 'application/manifest+json');
  assert.ok(read('vendor/zetaphy-tools-lib.js').startsWith('// Generated by `npm run build`'));
  // no markup sinks in the new modules either (the main unit test checks every src/ file)
  for (const f of ['sw.js', 'offline.html']) for (const sink of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'eval(', '<script']) assert.ok(!read(f).includes(sink), `${f}: ${sink}`);
  assert.equal(keccak_256(new Uint8Array()).length, 32);
});
