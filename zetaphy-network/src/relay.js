// Relay: a small HTTP endpoint a node runner can expose so users who hold
// only a stablecoin can use Neuro. The user signs a JobRequest (and a
// permit) in their wallet; the relay submits it, pays the gas in ZETAPHY,
// and earns the tip the user agreed to. Nothing secret is sent to it.
//
//   POST /request  {"request": {...JobRequest}, "signature": "0x…", "permit": {value,deadline,v,r,s}?}
//   POST /faucet   {"token": "usdc"|"usdt", "address": "0x…"}   test stablecoins (testnet only)
//   GET  /info     gateway address, accepted tokens, minimum tip

import http from 'node:http';
import { getAddress, isHexString } from 'ethers';

const MAX_BODY = 8 * 1024;

export function validRequest(q) {
  const big = (v) => { try { return BigInt(v) >= 0n; } catch { return false; } };
  return q && typeof q === 'object'
    && [q.user, q.token].every((a) => { try { getAddress(a); return true; } catch { return false; } })
    && isHexString(q.chain, 32) && typeof q.target === 'string' && q.target.length > 0 && q.target.length <= 64
    && ['fee', 'tip', 'maxCost', 'nonce', 'deadline'].every((k) => big(q[k]));
}

/**
 * @param {object} p
 * @param {import('ethers').Contract} p.gateway  StableGateway bound to the relay's wallet
 * @param {bigint} p.minTip                      smallest tip (stablecoin units) worth the gas
 * @param {number} [p.perMinute]                 requests per IP per minute
 */
/** @param {Record<string, import('ethers').Contract>} [p.tokens]  {usdc, usdt} TestStable contracts bound to the relay wallet */
export function createRelay({ gateway, tokens = {}, minTip, perMinute = 6, log = () => {} }) {
  const hits = new Map();
  const limited = (ip) => {
    const now = Date.now();
    const recent = (hits.get(ip) ?? []).filter((t) => now - t < 60_000);
    recent.push(now);
    hits.set(ip, recent);
    return recent.length > perMinute;
  };

  async function handle(body) {
    const { request: q, signature, permit } = body ?? {};
    if (!validRequest(q) || !isHexString(signature, 65)) return [400, { error: 'bad request' }];
    if (BigInt(q.tip) < minTip) return [400, { error: `tip below ${minTip}` }];
    const tuple = [q.user, q.token, q.chain, q.target, q.fee, q.tip, q.maxCost, q.nonce, q.deadline];
    const args = permit ? [tuple, signature, [permit.value, permit.deadline, permit.v, permit.r, permit.s]] : [tuple, signature];
    const fn = permit ? 'requestWithPermit' : 'request';
    try {
      await gateway[fn].staticCall(...args); // refuse anything that would revert, before paying gas
      const rc = await (await gateway[fn](...args)).wait();
      const ev = rc.logs.map((l) => { try { return gateway.interface.parseLog(l); } catch { return null; } }).find((e) => e?.name === 'Paid');
      log(`relayed job ${ev?.args.jobId} for ${q.user}`);
      return [200, { jobId: ev?.args.jobId.toString(), tx: rc.hash }];
    } catch (e) {
      return [422, { error: e.revert?.name ?? e.shortMessage ?? 'rejected' }];
    }
  }

  async function faucet(body) {
    const t = tokens[body?.token];
    let to;
    try { to = getAddress(body?.address); } catch { return [400, { error: 'bad address' }]; }
    if (!t) return [400, { error: `token must be one of ${Object.keys(tokens).join(', ')}` }];
    try {
      await t.faucetTo.staticCall(to);
      const rc = await (await t.faucetTo(to)).wait();
      log(`faucet ${body.token} -> ${to}`);
      return [200, { tx: rc.hash }];
    } catch (e) {
      return [422, { error: e.reason ?? e.shortMessage ?? 'rejected' }];
    }
  }

  return http.createServer((req, res) => {
    const reply = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json', 'access-control-allow-origin': '*' }); res.end(JSON.stringify(obj)); };
    if (req.method === 'OPTIONS') { res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'POST, GET', 'access-control-allow-headers': 'content-type' }); return res.end(); }
    if (req.method === 'GET' && req.url === '/info') {
      return reply(200, { gateway: gateway.target, minTip: minTip.toString(), tokens: Object.fromEntries(Object.entries(tokens).map(([k, c]) => [k, c.target])) });
    }
    if (req.method !== 'POST' || (req.url !== '/request' && req.url !== '/faucet')) return reply(404, { error: 'not found' });
    if (limited(req.socket.remoteAddress)) return reply(429, { error: 'too many requests' });
    let size = 0;
    const chunks = [];
    req.on('data', (d) => { size += d.length; if (size > MAX_BODY) { reply(413, { error: 'too large' }); req.destroy(); } else chunks.push(d); });
    req.on('end', async () => {
      if (size > MAX_BODY) return;
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return reply(400, { error: 'bad json' }); }
      const [code, obj] = req.url === '/faucet' ? await faucet(body) : await handle(body);
      reply(code, obj);
    });
  });
}
