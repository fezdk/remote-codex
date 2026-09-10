import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { createWebServer } from '../server/http.js';
import { FixtureCodex } from './fixture.js';
// Public synthetic credential; never read or use the live server's access key.
const token = 'synthetic-security-probe-key-only';
async function setup(t, options = {}) {
  const codex = new FixtureCodex();
  const server = createWebServer({ codex, token, publicDir: resolve('public'), ...options });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeStreams(); server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const req = (path, body, headers = {}) => new Promise((resolve, reject) => { const request = http.request(base + path, { method: body === undefined ? 'GET' : 'POST', headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers } }, response => { response.resume(); response.on('end', () => resolve({ status: response.statusCode, headers: { get: name => Array.isArray(response.headers[name]) ? response.headers[name][0] : response.headers[name] } })); }); request.on('error', reject); request.end(body === undefined ? undefined : JSON.stringify(body)); });
  return { codex, server, base, req };
}
test('unauthenticated API route matrix never reaches Codex', async t => {
  const { codex, req } = await setup(t);
  const paths = ['/api/status', '/api/models', '/api/projects?path=/', '/api/events', '/api/threads', '/api/respond', '/api/logout'];
  for (const action of ['open', 'turns', 'message', 'interrupt', 'changes', 'git', 'git-diff', 'queue', 'skills', 'status', 'command', 'settings', 'queue/synthetic/delete', 'queue/synthetic/start']) paths.push('/api/threads/session-one/' + action);
  for (const path of paths) for (const body of [undefined, {}]) assert.equal((await req(path, body)).status, 401, path);
  assert.equal(codex.calls.length, 0);
  assert.equal(codex.subscriptions.size, 0);
});
test('configured HTTPS origin sets Secure and rejects untrusted hosts/origins/fetch context', async t => {
  const { req } = await setup(t, { origin: 'https://codex.example.com' });
  const headers = { Host: 'codex.example.com', Origin: 'https://codex.example.com' };
  const login = await req('/api/login', { token }, headers);
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie');
  assert.match(cookie, /; Secure/);
  assert.match(cookie, /HttpOnly; SameSite=Strict/);
  assert.equal((await req('/api/status', undefined, { ...headers, Cookie: cookie.split(';')[0] })).status, 200);
  for (const change of [{ Host: 'attacker.example' }, { Origin: 'null' }, { Origin: 'https://attacker.example' }, { 'Sec-Fetch-Site': 'cross-site' }]) {
    assert.equal((await req('/api/login', { token }, { ...headers, ...change })).status, 403);
  }
});
test('expired login cannot receive broadcast or access API', { timeout: 5000 }, async t => {
  const { req, base, codex } = await setup(t);
  const login = await req('/api/login', { token });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const stream = await new Promise((resolve, reject) => { const request = http.get(base + '/api/events', { headers: { Cookie: cookie } }, resolve); request.on('error', reject); });
  let text = ''; stream.setEncoding('utf8'); stream.on('data', chunk => { text += chunk; });
  await new Promise(resolve => setTimeout(resolve, 20));
  const ended = once(stream, 'end');
  const now = Date.now;
  try {
    const future = now() + 13 * 60 * 60 * 1000;
    Date.now = () => future;
    codex.event('synthetic/private', { text: 'must-not-arrive-after-expiry' });
    await ended;
    assert.equal((await req('/api/status', undefined, { Cookie: cookie })).status, 401);
  } finally { Date.now = now; }
  assert.equal(text.includes('must-not-arrive-after-expiry'), false);
});
test('oversized/malformed HTTP and traversal fail without upstream actions or process loss', async t => {
  const { req, base, codex } = await setup(t);
  const raw = (path, data, headers = {}) => new Promise((resolve, reject) => {
    const request = http.request(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers } }, response => { response.resume(); response.on('end', () => resolve(response.statusCode)); });
    request.on('error', reject); request.end(data);
  });
  assert.equal(await raw('/api/login', '{'), 400);
  for (const data of ['null', '[]', 'true', '123', '"string"']) assert.equal(await raw('/api/login', data), 400);
  assert.equal(await raw('/api/login', JSON.stringify({ token: 'x'.repeat(1024 * 1024) })), 413);
  assert.equal(await raw('/api/login', '{}', { 'X-Oversized': 'a'.repeat(24 * 1024) }), 431);
  assert.equal(await raw('/api/login', '{}', { 'Content-Length': '2', 'Transfer-Encoding': 'chunked' }), 400);
  const login = await req('/api/login', { token }); assert.equal(login.status, 200);
  const Cookie = login.headers.get('set-cookie').split(';')[0];
  for (const path of ['/.remote-codex/access-key', '/server/index.js', '/package.json', '/%2e%2e/server/index.js', '/..%2fserver%2findex.js', '/%252e%252e%252fserver%252findex.js', '/app.js/../../server/index.js', '/app.js%00']) assert.equal((await req(path, undefined, { Cookie })).status, 404, path);
  assert.equal((await req('/api/status', undefined, { Cookie })).status, 200);
  assert.equal(codex.calls.length, 0);
});
