// The web app's pure modules: the ABI codec (against ethers), metadata safety
// (URIs, size limits, text cleaning), amounts, bounded log scanning with its
// cache, wording rules for the Neuro texts, and both languages complete.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AbiCoder, Interface, id as ethersId, getAddress } from 'ethers';
import { encode, decode, fn, event, checksum, topicOf } from '../web/lib/abi.js';
import { resolveUri, normalizeTokenUri, imageSrc, readMetadata, fetchMetadataJson, cleanText, cleanMultiline, substituteId, normalizeGateway, MAX_METADATA } from '../web/lib/meta.js';
import { parseZtphy, formatZtphy, F, E, STATUS, listingFrom } from '../web/lib/contracts.js';
import { scanLogs } from '../web/lib/rpc.js';
import { t, keysOf, errorText } from '../web/lib/i18n.js';
import { artifacts } from './helpers/chain.js';

const coder = AbiCoder.defaultAbiCoder();
const A1 = '0x1111111111111111111111111111111111111111';

test('ABI encoding matches ethers for every shape the site sends', () => {
  const cases = [
    [['uint256', 'address', 'bool'], [123n, A1, true]],
    [['string', 'bytes', 'uint64'], ['สวัสดี NFT ✨', '0xdeadbeef', 2n ** 64n - 1n]],
    [['(string,string,string,string,address,uint96,uint256,bool,uint256)'], [['Siam', 'S', 'ipfs://x/', '', A1, 500n, 0n, true, 10n ** 18n]]],
    [['uint256[]', 'address[]'], [[1n, 2n, 3n], [A1, A1]]],
    [['string[]', 'bytes32', 'int256'], [['a', 'bc'], '0x' + 'ab'.repeat(32), -5n]],
    [['(uint256,string)[]'], [[[1n, 'x'], [2n, 'yy']]]],
  ];
  for (const [types, vals] of cases) {
    assert.equal('0x' + encode(types, vals), coder.encode(types, vals), types.join());
    const back = decode(types, coder.encode(types, vals));
    assert.equal(coder.encode(types, back), coder.encode(types, vals), `round trip ${types}`);
  }
  assert.throws(() => encode(['uint8'], [256n]));
  assert.throws(() => encode(['address'], ['0x12']));
});

test('function selectors and calls match the compiled ABIs', () => {
  const ifaces = [artifacts.NFTMarketplace, artifacts.NFTFactory, artifacts.ZetaphyERC721, artifacts.ZetaphyERC1155].map((a) => new Interface(a.abi));
  const known = new Set(ifaces.flatMap((i) => i.fragments.filter((f) => f.type === 'function').map((f) => f.selector)));
  const generic = new Set(['supportsInterface', 'royaltyInfo']);
  for (const [k, f] of Object.entries(F)) {
    if (generic.has(f.name)) continue;
    assert.ok(known.has(f.selector), `${k} ${f.signature} is a real function`);
  }
  const m = new Interface(artifacts.NFTMarketplace.abi);
  assert.equal(F.list.encode(A1, 7n, 1n, 10n ** 18n, 1_900_000_000n), m.encodeFunctionData('list', [A1, 7n, 1n, 10n ** 18n, 1_900_000_000n]));
  const fac = new Interface(artifacts.NFTFactory.abi);
  const cfg = ['N', 'S', '', 'ipfs://c', A1, 250n, 5n, false, 0n];
  assert.equal(F.createERC721.encode(cfg), fac.encodeFunctionData('createERC721', [cfg]));
  // Decoding a struct answer.
  const ret = m.encodeFunctionResult('getListing', [[A1, 99n, 1, A1, 0n, 5n, 7n, 1n, 3n, 4n, true, 6n]]);
  const l = F.getListing.decode(ret);
  assert.equal(l[1], 99n);
  assert.equal(l[6], 7n);
  assert.deepEqual(listingFrom(l), { seller: getAddress(A1), expiry: 99, kind: 1, collection: getAddress(A1), nonce: 0n, tokenId: 5n, unitPrice: 7n, quantity: 1n, tokenNonce: 3n, moves: 4n, tracked: true, minUnitProceeds: 6n });
  assert.equal(F.acceptOffer.encode(4n, 10n ** 18n), m.encodeFunctionData('acceptOffer', [4n, 10n ** 18n]));
  // Every listingStatus value has a name (and a text, see the i18n test).
  assert.equal(STATUS.length, 10, 'NFTMarketplace.Status has 10 values');
  assert.match(errorText('en', { data: m.getError('TokenMoved').selector }), /left the seller outside the marketplace/);
  assert.equal(F.approve.encode(A1, 7n), new Interface(artifacts.ZetaphyERC721.abi).encodeFunctionData('approve', [A1, 7n]));
  for (const st of STATUS) for (const lang of ['en', 'th']) assert.ok(keysOf(lang).includes(`status_${st}`), `${lang}.status_${st}`);
  // Events: topics equal ethers', decoding of indexed and data fields.
  for (const [k, ev] of Object.entries(E)) {
    const src = [...ifaces].find((i) => { try { return i.getEvent(ev.name); } catch { return false; } });
    if (src) assert.equal(ev.topic, src.getEvent(ev.name).topicHash, k);
  }
  const log = m.encodeEventLog('Listed', [3n, A1, A1, 9n, 1n, 5n, 77n]);
  assert.deepEqual(E.Listed.decode(log), { id: 3n, seller: getAddress(A1), collection: getAddress(A1), tokenId: 9n, quantity: 1n, unitPrice: 5n, expiry: 77n });
  assert.equal(topicOf(A1), '0x' + '0'.repeat(24) + A1.slice(2));
  assert.equal(checksum('0xa000000000000000000000000000000000000001'), getAddress('0xa000000000000000000000000000000000000001'));
  assert.equal(fn('transfer(address,uint256)').selector, ethersId('transfer(address,uint256)').slice(0, 10));
});

test('ABI decoding refuses malformed answers instead of misreading them', () => {
  const f = fn('x()', ['string']);
  assert.throws(() => f.decode('0x'), /too short/);
  assert.throws(() => f.decode('0x' + (32n).toString(16).padStart(64, '0') + 'ff'.repeat(32)), /offset|length/);
  assert.throws(() => fn('x()', ['address']).decode('0x' + 'ff'.repeat(32)), /dirty address/);
  assert.throws(() => fn('x()', ['bool']).decode('0x' + '0'.repeat(63) + '2'), /dirty bool/);
  assert.throws(() => fn('x()', ['uint8']).decode('0x' + '0'.repeat(61) + '100'), /dirty uint8/);
  assert.throws(() => event('T(address indexed a)').decode({ topics: ['0x' + '0'.repeat(64)], data: '0x' }), /not this event/);
  // An ERC-20 Transfer (tokenId not indexed) is not mistaken for an ERC-721 one.
  const erc20 = { topics: [E.Transfer721.topic, topicOf(A1), topicOf(A1)], data: '0x' + '0'.repeat(63) + '5' };
  assert.throws(() => E.Transfer721.decode(erc20), /topic count/);
});

test('token URIs: only ipfs (via an https gateway), https and data are followed', () => {
  const gw = 'https://gw.example/ipfs/';
  assert.deepEqual(resolveUri('ipfs://bafyabc/1.json', gw), { kind: 'https', url: 'https://gw.example/ipfs/bafyabc/1.json' });
  assert.deepEqual(resolveUri('ipfs://ipfs/QmX/meta.json', gw), { kind: 'https', url: 'https://gw.example/ipfs/QmX/meta.json' });
  assert.equal(resolveUri('https://example.org/a.json').url, 'https://example.org/a.json');
  for (const bad of ['http://example.org/a.json', 'javascript:alert(1)', 'file:///etc/passwd', 'blob:x', 'ftp://x', 'ipfs://../x', 'https://user:pw@example.org/', 'ipfs://abc‮/x', '']) {
    assert.equal(resolveUri(bad, gw), null, bad);
  }
  assert.equal(normalizeTokenUri('bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi/1.json'), 'ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi/1.json');
  assert.equal(normalizeTokenUri('QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG'), 'ipfs://QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG');
  assert.equal(normalizeTokenUri('http://x'), null);
  assert.equal(normalizeTokenUri('  '), '');
  assert.equal(substituteId('ipfs://b/{id}.json', 255n), `ipfs://b/${'0'.repeat(62)}ff.json`);
  assert.equal(normalizeGateway('https://dweb.link/ipfs'), 'https://dweb.link/ipfs/');
  assert.equal(normalizeGateway('http://dweb.link/ipfs/'), null);
});

test('images: only <img>-safe sources; SVG only as a data:image or URL, never inline', () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>';
  assert.equal(imageSrc('ipfs://bafyimg/a.png', 'https://gw.example/ipfs/'), 'https://gw.example/ipfs/bafyimg/a.png');
  assert.ok(imageSrc('data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64')).startsWith('data:image/svg+xml;base64,'));
  assert.equal(imageSrc('data:text/html,<script>alert(1)</script>'), null);
  assert.equal(imageSrc('data:image/svg+xml" onerror="x,abc'), null);
  assert.equal(imageSrc('javascript:alert(1)'), null);
  assert.equal(imageSrc('http://example.org/a.png'), null);
  assert.equal(imageSrc('data:image/png;base64,' + 'A'.repeat(3 * 1024 * 1024)), null, 'too large');
  const md = readMetadata({ name: 'Evil‮gnp.exe\u0000<b>x</b>', description: 'line1\n\n\n\nline2​<img src=x onerror=alert(1)>', image_data: svg,
    attributes: [{ trait_type: 'Color‮', value: 'Red' }, { trait_type: 'Obj', value: { a: 1 } }], external_url: 'javascript:alert(1)', animation_url: 'https://x/a.html' });
  assert.equal(md.name, 'Evilgnp.exe<b>x</b>', 'bidi/control removed; markup stays text');
  assert.equal(md.description, 'line1\n\nline2<img src=x onerror=alert(1)>');
  assert.ok(md.image.startsWith('data:image/svg+xml;charset=utf-8,'));
  assert.deepEqual(md.attributes, [{ trait: 'Color', value: 'Red' }, { trait: 'Obj', value: '{"a":1}' }]);
  assert.equal(md.externalUrl, null);
  assert.equal('animation_url' in md, false);
  assert.equal(cleanText('a\tb\nc'), 'a b c');
  assert.equal(cleanMultiline('a\r\nb'), 'a\nb');
});

test('metadata fetch: data: and https, size-limited, JSON objects only, no credentials', async () => {
  const json = { name: 'One', image: 'ipfs://bafyimg/1.png' };
  const b64 = 'data:application/json;base64,' + Buffer.from(JSON.stringify(json)).toString('base64');
  assert.deepEqual(await fetchMetadataJson(b64), json);
  assert.deepEqual(await fetchMetadataJson('data:application/json,' + encodeURIComponent(JSON.stringify(json))), json);
  await assert.rejects(fetchMetadataJson('data:text/html,<p>'), /not JSON/);
  await assert.rejects(fetchMetadataJson('data:application/json,[1,2]'), /not a metadata object/);
  await assert.rejects(fetchMetadataJson('data:application/json;base64,' + Buffer.from('x'.repeat(MAX_METADATA + 10)).toString('base64')), /too large/);
  let seen;
  const okFetch = async (url, init) => { seen = { url, init }; return new Response(JSON.stringify(json), { status: 200 }); };
  assert.deepEqual(await fetchMetadataJson('ipfs://bafymeta/1.json', { gateway: 'https://gw.example/ipfs/', fetchImpl: okFetch }), json);
  assert.equal(seen.url, 'https://gw.example/ipfs/bafymeta/1.json');
  assert.equal(seen.init.credentials, 'omit');
  assert.equal(seen.init.referrerPolicy, 'no-referrer');
  // A body that streams past the limit is cut off.
  const big = async () => new Response(new ReadableStream({ start(c) { for (let i = 0; i < 40; i++) c.enqueue(new Uint8Array(10_000).fill(32)); c.close(); } }));
  await assert.rejects(fetchMetadataJson('https://x.example/m.json', { fetchImpl: big }), /too large/);
  const lying = async () => new Response('{}', { headers: { 'content-length': String(10 * MAX_METADATA) } });
  await assert.rejects(fetchMetadataJson('https://x.example/m.json', { fetchImpl: lying }), /too large/);
  await assert.rejects(fetchMetadataJson('http://x.example/m.json', { fetchImpl: okFetch }), /unsupported/);
});

test('ZTPHY amounts parse and format exactly', () => {
  assert.equal(parseZtphy('1.5'), 1_500_000_000_000_000_000n);
  assert.equal(parseZtphy('0.000000000000000001'), 1n);
  assert.equal(parseZtphy('1.0000000000000000001'), null);
  assert.equal(parseZtphy('-1'), null);
  assert.equal(parseZtphy('1e18'), null);
  assert.equal(formatZtphy(1_234_567_890_123_456_789n), '1.234567');
  assert.equal(formatZtphy(1_000_000n * 10n ** 18n), '1,000,000');
  assert.equal(formatZtphy(1n), '<0.000001');
  assert.equal(formatZtphy(0n), '0');
});

test('log scanning: bounded chunks, split on refusal, cache continues where it stopped', async () => {
  let head = 10_000;
  const calls = [];
  const all = Array.from({ length: 50 }, (_, i) => ({ blockNumber: '0x' + (i * 200 + 5).toString(16), logIndex: '0x0', n: i }));
  const rpc = {
    blockNumber: async () => head,
    getLogs: async ({ fromBlock, toBlock }) => {
      calls.push([fromBlock, toBlock]);
      if (toBlock - fromBlock + 1 > 2000) throw new Error('block range too large');
      const inRange = all.filter((l) => Number(l.blockNumber) >= fromBlock && Number(l.blockNumber) <= toBlock);
      if (inRange.length > 6) throw new Error('logs cap');
      return inRange;
    },
  };
  const mem = new Map();
  const store = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v), removeItem: (k) => mem.delete(k) };
  const r = await scanLogs(rpc, {}, { maxBlocks: 4000, step: 2000, cacheKey: 'k', store });
  assert.ok(calls.every(([a, b]) => b - a + 1 <= 2000), 'never more than step blocks');
  assert.ok(calls.some(([a, b]) => b - a + 1 < 2000), 'split when the node refused');
  assert.deepEqual(r.logs.map((l) => l.n), [49, 48, 47, 46, 45, 44, 43, 42, 41, 40, 39, 38, 37, 36, 35, 34, 33, 32, 31, 30]);
  assert.equal(r.complete, false);
  // Later: 1000 new blocks; only those are asked, plus the cached ones are reused.
  head = 11_000;
  all.push({ blockNumber: '0x' + (10_500).toString(16), logIndex: '0x0', n: 'new' });
  calls.length = 0;
  const r2 = await scanLogs(rpc, {}, { maxBlocks: 4000, want: 5, cacheKey: 'k', store });
  assert.deepEqual(calls, [[10_001, 11_000]]);
  assert.equal(r2.logs[0].n, 'new');
  assert.equal(r2.logs.length, 21);
  // want: stops going back once enough are found.
  calls.length = 0;
  const r3 = await scanLogs(rpc, {}, { maxBlocks: 100_000, want: 3, store });
  assert.ok(calls.length <= 3);
  assert.ok(r3.logs.length >= 3);
  // floor: never below the deploy block.
  calls.length = 0;
  const r4 = await scanLogs(rpc, {}, { floor: 9_000, maxBlocks: 100_000, store });
  assert.ok(calls.every(([a]) => a >= 9_000));
  assert.equal(r4.complete, true);
});

test('both languages have every text; Neuro wording stays neutral and carries the disclaimer', () => {
  const en = keysOf('en'), th = keysOf('th');
  assert.deepEqual([...th].sort(), [...en].sort());
  const banned = /scam|fraud|rug|phish|drainer|honeypot|criminal|steal|thief|หลอกลวง|โกง|มิจฉาชีพ|ต้มตุ๋น|ขโมย/i;
  for (const lang of ['en', 'th']) for (const k of keysOf(lang)) assert.doesNotMatch(t(lang, k), banned, `${lang}.${k}`);
  assert.match(t('th', 'footer'), /ข้อมูลวิเคราะห์โค้ดอัตโนมัติ ไม่ใช่คำกล่าวหา/);
  assert.equal(t('en', 'hiddenListings', { n: 3 }).startsWith('3 '), true);
  const sel = new Interface(artifacts.NFTMarketplace.abi).getError('CollectionRefused').selector;
  assert.match(errorText('th', { data: sel + '0'.repeat(63) + '3' }), /ธง Neuro/);
  assert.equal(errorText('en', { message: 'execution reverted: registry down' }), 'registry down');
});

test('wallet: ensureChain re-reads the chain after switch/add; assertChain refuses anything but 77390', async () => {
  const { ensureChain, assertChain } = await import('../web/lib/wallet.js');
  const fake = (chains, { switchFails = false } = {}) => {
    const seen = [];
    let i = 0;
    return { seen, request: async ({ method }) => {
      seen.push(method);
      if (method === 'eth_chainId') return chains[Math.min(i++, chains.length - 1)];
      if (method === 'wallet_switchEthereumChain' && switchFails) throw Object.assign(new Error('Unrecognized chain'), { code: 4902 });
      return null;
    } };
  };
  await ensureChain(fake(['0x12e4e']), 'https://rpc');
  const ok = fake(['0x1', '0x12e4e']);
  await ensureChain(ok, 'https://rpc');
  assert.deepEqual(ok.seen, ['eth_chainId', 'wallet_switchEthereumChain', 'eth_chainId']);
  // The wallet says "switched" but stays on chain 1: refused.
  await assert.rejects(ensureChain(fake(['0x1', '0x1']), 'https://rpc'), (e) => e.code === 'WRONG_CHAIN');
  const added = fake(['0x38', '0x12e4e'], { switchFails: true });
  await ensureChain(added, 'https://rpc');
  assert.deepEqual(added.seen, ['eth_chainId', 'wallet_switchEthereumChain', 'wallet_addEthereumChain', 'eth_chainId']);
  await assertChain(fake([77390]));
  for (const bad of ['0x1', null, 'nonsense', {}, '0x12e4f']) await assert.rejects(assertChain(fake([bad])), (e) => e.code === 'WRONG_CHAIN', String(bad));
  const sel = new Interface(artifacts.NFTMarketplace.abi).getError('ProceedsTooLow').selector;
  assert.match(errorText('en', { data: sel + '0'.repeat(128) }), /receive less than shown/);
});
