import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { FixtureCodex } from './fixture.js';
import { createSessionTools } from '../server/session-tools.js';
import { createWebServer } from '../server/http.js';
import { createState, applyEvent } from '../public/state.js';

test('model discovery pages through the native catalog and rejects cursor loops', async () => {
  const calls = [];
  const codex = { rpc: async (method, params) => {
    calls.push({ method, params });
    return { data: [{ model: params.cursor ? 'second' : 'first', displayName: 'Demo', supportedReasoningEfforts: [{ reasoningEffort: 'ultra', description: 'From catalog' }], defaultReasoningEffort: 'ultra' }], nextCursor: params.cursor ? null : 'next' };
  } };
  const tools = createSessionTools(codex);
  const catalog = await tools.models(); assert.deepEqual(catalog.models.map(model => model.model), ['first', 'second']);
  assert.equal(catalog.models[0].efforts[0].effort, 'ultra');
  assert.equal(calls[0].params.includeHidden, false); assert.equal(calls[1].params.cursor, 'next');
  codex.rpc = async () => ({ data: [], nextCursor: 'same' });
  await assert.rejects(tools.models(), error => error.errorKey === 'models.pagination');
});

test('model selection requires authentication, an open session and a supported model/effort pair; unrelated settings never reach Codex', async t => {
  const codex = new FixtureCodex(), server = createWebServer({ codex, token: 'synthetic-model-picker-test-key', publicDir: resolve('public') });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeStreams(); server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(base + '/api/models')).status, 401);
  assert.equal((await fetch(base + '/api/threads/session-one/settings')).status, 401);
  const login = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: 'synthetic-model-picker-test-key' }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const request = (path, data) => fetch(base + path, { method: data === undefined ? 'GET' : 'POST', headers: { cookie, 'Content-Type': 'application/json' }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
  const path = '/api/threads/session-one/settings';
  assert.equal((await request(path, { model: 'local-model', effort: 'high' })).status, 409);
  await request('/api/threads/session-one/open', {});
  assert.deepEqual((await (await request('/api/models')).json()).models.map(model => model.model), ['local-model', 'demo-fast']);
  for (const value of [{ model: 'invented', effort: 'high' }, { model: 'demo-hidden' }, { model: 'demo-fast', effort: 'high' }]) assert.equal((await request(path, value)).status, 409);
  for (const value of [{ model: null }, { model: 'local-model', effort: null }, { model: 'local-model', effort: {} }]) assert.equal((await request(path, value)).status, 400);
  assert.equal(codex.calls.filter(call => call.method === 'thread/settings/update').length, 0);
  await request('/api/threads/session-one/message', { text: 'long' });
  const response = await request(path, { model: 'demo-fast', effort: 'low', approvalPolicy: 'never', sandboxPolicy: { type: 'dangerFullAccess' }, cwd: '/different' });
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), { model: 'demo-fast', reasoningEffort: 'low' });
  assert.deepEqual(codex.calls.findLast(call => call.method === 'thread/settings/update').params, { threadId: 'session-one', model: 'demo-fast', effort: 'low' });
  assert.equal(codex.turns.at(-1).status, 'inProgress');
  assert.deepEqual(await (await request(path)).json(), { model: 'demo-fast', reasoningEffort: 'low' });
});

test('live model and effort updates affect the matching session only', () => {
  const state = createState(); state.selectedId = 'one'; state.thread = { id: 'one', model: 'old', reasoningEffort: 'medium' }; state.threads = [{ ...state.thread }, { id: 'two', model: 'other' }];
  applyEvent(state, { method: 'thread/settings/updated', params: { threadId: 'two', threadSettings: { model: 'second', effort: 'low' } } });
  assert.equal(state.thread.model, 'old'); assert.equal(state.threads[1].model, 'second');
  applyEvent(state, { method: 'thread/settings/updated', params: { threadId: 'one', threadSettings: { model: 'new', effort: 'high' } } });
  assert.equal(state.thread.model, 'new'); assert.equal(state.thread.reasoningEffort, 'high'); assert.equal(state.threads[0].reasoningEffort, 'high');
});
