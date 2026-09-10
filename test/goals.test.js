import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { createGoals } from '../server/goals.js';
import { createWebServer } from '../server/http.js';
import { FixtureCodex } from './fixture.js';

const objective = 'Complete the synthetic migration';
test('goal creation, budget edits and lifecycle use native state and preserve accounting', async () => {
  const codex = new FixtureCodex(), goals = createGoals(codex), id = 'session-one';
  let state = await goals.read(id); assert.deepEqual(state, { goal: null, version: null });
  state = await goals.change(id, { action: 'create', version: state.version, objective, tokenBudget: 40000, sandbox: 'dangerFullAccess' });
  assert.equal(state.goal.status, 'active');
  Object.assign(codex.goals.get(id), { tokensUsed: 1200, timeUsedSeconds: 42 });
  for (const status of ['paused', 'active', 'blocked', 'complete']) {
    state = await goals.change(id, { action: 'status', version: state.version, status });
    assert.equal(state.goal.status, status); assert.equal(state.goal.tokensUsed, 1200);
  }
  state = await goals.change(id, { action: 'update', version: state.version, objective, tokenBudget: null });
  assert.equal(state.goal.tokensUsed, 1200); assert.equal(state.goal.tokenBudget, null);
  assert.equal(Object.hasOwn(codex.calls.findLast(call => call.method === 'thread/goal/set').params, 'objective'), false);
  state = await goals.change(id, { action: 'update', version: state.version, objective: 'A different objective', tokenBudget: 30000 });
  assert.equal(state.goal.tokensUsed, 0);
  assert.deepEqual(await goals.change(id, { action: 'clear', version: state.version }), { goal: null, version: null });
  assert.ok(codex.calls.every(call => call.method.startsWith('thread/goal/')));
  assert.deepEqual(codex.calls.find(call => call.method === 'thread/goal/set').params, { threadId: id, objective, tokenBudget: 40000, status: 'active' });
});

test('invalid budgets, objectives, status and stale forms cannot mutate a goal', async () => {
  const codex = new FixtureCodex(), goals = createGoals(codex), id = 'session-one';
  const create = { action: 'create', version: null, objective, tokenBudget: null };
  for (const tokenBudget of [0, -1, 1.5, '', '100', {}, Number.MAX_SAFE_INTEGER + 1]) await assert.rejects(goals.change(id, { ...create, tokenBudget }), error => error.errorKey === 'goals.budgetInvalid');
  for (const objective of ['', '   ', 'a'.repeat(4001), 'bad\0text', null]) await assert.rejects(goals.change(id, { ...create, objective }), error => error.errorKey === 'goals.objectiveInvalid');
  for (const status of ['invented', 'usageLimited', 'budgetLimited', null]) await assert.rejects(goals.change(id, { action: 'status', version: null, status }));
  assert.equal(codex.calls.length, 0);
  const old = await goals.change(id, create);
  await goals.change(id, { action: 'status', version: old.version, status: 'paused' });
  await assert.rejects(goals.change(id, { action: 'clear', version: old.version }), error => error.status === 409);
  await assert.rejects(goals.change(id, create), error => error.status === 409);
  assert.equal(codex.goals.get(id).status, 'paused');
});

test('parallel mutations are rejected, and failed requests are never replayed', async () => {
  const codex = new FixtureCodex(), goals = createGoals(codex), original = codex.rpc.bind(codex);
  let release; const gate = new Promise(resolve => { release = resolve; });
  codex.rpc = async (method, params) => { if (method === 'thread/goal/set') { await gate; await original(method, params); throw new Error('Acknowledgement lost'); } return original(method, params); };
  const input = { action: 'create', objective, tokenBudget: null, version: null };
  const first = goals.change('session-one', input);
  await assert.rejects(goals.change('session-one', input), error => error.errorKey === 'goals.busy');
  release(); await assert.rejects(first, /Acknowledgement lost/);
  assert.equal((await goals.read('session-one')).goal.objective, objective);
  assert.equal(codex.calls.filter(call => call.method === 'thread/goal/set').length, 1);
});

test('goal routes require authentication, same origin and an open session for mutations', async t => {
  const codex = new FixtureCodex(), server = createWebServer({ codex, token: 'synthetic-goal-test-key', publicDir: resolve('public') });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeStreams(); server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`, path = '/api/threads/session-one/goal';
  const data = { action: 'create', version: null, objective, tokenBudget: null };
  for (const method of ['GET', 'POST']) assert.equal((await fetch(base + path, { method, ...(method === 'POST' ? { body: JSON.stringify(data) } : {}) })).status, 401);
  assert.equal(codex.calls.length, 0);
  const login = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: 'synthetic-goal-test-key' }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const post = (path, value, origin) => fetch(base + path, { method: 'POST', headers: { cookie, 'Content-Type': 'application/json', ...(origin ? { origin } : {}) }, body: JSON.stringify(value) });
  assert.equal((await post(path, data, 'https://evil.example')).status, 403);
  assert.equal((await post(path, data)).status, 409);
  await post('/api/threads/session-one/open', {});
  assert.equal((await post(path, data)).status, 200);
  const result = await (await fetch(base + path, { headers: { cookie } })).json(); assert.equal(result.goal.objective, objective);
});
