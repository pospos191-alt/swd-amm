// What the API functions share (server/http.js): the caller's IP and CORS for the hub only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clientIp, cors, hubHosts } from '../server/http.js';

test('client IP: Vercel header first, first address only, bounded', () => {
  assert.equal(clientIp({ headers: { 'x-vercel-forwarded-for': '9.9.9.9', 'x-forwarded-for': '1.1.1.1' } }), '9.9.9.9');
  assert.equal(clientIp({ headers: { 'x-forwarded-for': '1.1.1.1, 2.2.2.2' } }), '1.1.1.1');
  assert.equal(clientIp({ headers: {}, socket: { remoteAddress: '3.3.3.3' } }), '3.3.3.3');
  assert.equal(clientIp({ headers: { 'x-real-ip': 'x'.repeat(500) } }).length, 64);
});

test('CORS: only the hub\'s https origins; preflight answered', () => {
  const hosts = hubHosts({});
  assert.deepEqual(hosts, ['app.sawasdeecoin.com', 'zetaphy-hub.vercel.app']);
  assert.deepEqual(cors({ method: 'GET', headers: { origin: 'https://app.sawasdeecoin.com' } }, hosts).headers, { 'access-control-allow-origin': 'https://app.sawasdeecoin.com', vary: 'Origin' });
  for (const origin of ['https://evil.example', 'http://app.sawasdeecoin.com', 'https://app.sawasdeecoin.com.evil.example', 'null', '']) {
    assert.deepEqual(cors({ method: 'POST', headers: { origin } }, hosts).headers, {}, origin);
  }
  const pre = cors({ method: 'OPTIONS', headers: { origin: 'https://zetaphy-hub.vercel.app' } }, hosts, 'POST');
  assert.equal(pre.preflight, true);
  assert.equal(pre.status, 204);
  assert.equal(pre.headers['access-control-allow-methods'], 'POST');
  assert.equal(cors({ method: 'OPTIONS', headers: { origin: 'https://evil.example' } }, hosts).status, 403);
  assert.deepEqual(hubHosts({ NEURO_ALLOWED_ORIGIN_HOSTS: ' A.example , ,b.example' }), ['a.example', 'b.example']);
});
