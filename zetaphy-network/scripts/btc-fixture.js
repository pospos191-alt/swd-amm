// Rebuilds test/fixtures/btc-mainnet.json (real Bitcoin mainnet headers and one SPV proof) from
// two public files, and checks every header's double-SHA256 and proof of work before writing:
//   - summa-tx/relays testVectors.json (mainnet headers around the retarget at height 306432,
//     17 consecutive headers 562623-562639, and an SPV proof of a tx in block 592920)
//   - bitcoinjs/bitcoinjs-lib test/fixtures/block.json (the genesis block)
// Each header authenticates itself (its hash must be below the target its bits encode, and the
// chain links by prev hash), and each block hash can be compared with any block explorer.
// Usage: node scripts/btc-fixture.js            (needs network access to raw.githubusercontent.com)
import { writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const SOURCES = {
  relays: 'https://raw.githubusercontent.com/summa-tx/relays/master/testVectors.json',
  bitcoinjs: 'https://raw.githubusercontent.com/bitcoinjs/bitcoinjs-lib/master/test/fixtures/block.json',
};
const get = async (u) => { const r = await fetch(u); if (!r.ok) throw new Error(`${u}: ${r.status}`); return r.json(); };
const hex = (s) => String(s).replace(/^0x/, '').toLowerCase();
const dsha = (b) => createHash('sha256').update(createHash('sha256').update(b).digest()).digest();

/** Checks a raw 80-byte header: hash (internal byte order) and proof of work. */
function check(raw, wantHash) {
  const b = Buffer.from(hex(raw), 'hex');
  if (b.length !== 80) throw new Error('header is not 80 bytes');
  const h = dsha(b);
  if (wantHash && h.toString('hex') !== hex(wantHash)) throw new Error(`hash mismatch ${wantHash}`);
  const bits = b.readUInt32LE(72);
  const target = BigInt(bits & 0x7fffff) << BigInt(8 * ((bits >>> 24) - 3));
  if (BigInt('0x' + Buffer.from(h).reverse().toString('hex')) > target) throw new Error('no proof of work');
  return h.toString('hex');
}

const relays = await get(SOURCES.relays);
const bjs = await get(SOURCES.bitcoinjs);
const genesis = bjs.valid.find((x) => x.description === 'Genesis Block');
const chain = relays.header.validateHeaderChain[0];
const rt = relays.header.validateDifficultyChange[0];
const spv = relays.validator.validateProof[0].proof;

const h = (x) => ({ height: x.height, hash: hex(x.hash), raw: hex(x.raw) });
const out = {
  note: 'Real Bitcoin MAINNET data for test/btclc.test.js. Hashes are in internal byte order (the reverse of explorers). Rebuild and re-check with node scripts/btc-fixture.js.',
  sources: SOURCES,
  genesis: { height: 0, hash: Buffer.from(dsha(Buffer.from(genesis.hex.slice(0, 160), 'hex'))).toString('hex'), raw: genesis.hex.slice(0, 160) },
  chain: { anchor: h(chain.anchor), headers: chain.headers.map(h) },
  retarget: { periodStart: h(rt.prevEpochStart), anchor: h(rt.anchor), headers: rt.headers.map(h) },
  spv: {
    header: h(spv.confirming_header),
    tx: { version: hex(spv.version), vin: hex(spv.vin), vout: hex(spv.vout), locktime: hex(spv.locktime) },
    txid: hex(spv.tx_id), index: Number(spv.index),
    siblings: hex(spv.intermediate_nodes).match(/.{64}/g),
  },
};
for (const x of [out.genesis, out.chain.anchor, ...out.chain.headers, out.retarget.periodStart, out.retarget.anchor, ...out.retarget.headers, out.spv.header]) check(x.raw, x.hash);
const url = new URL('../test/fixtures/btc-mainnet.json', import.meta.url);
writeFileSync(url, JSON.stringify(out, null, 1) + '\n');
console.log(`wrote ${url.pathname}: ${2 + out.chain.headers.length + 2 + out.retarget.headers.length + 1} headers, all with valid proof of work`);
