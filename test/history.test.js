import test from 'node:test';
import assert from 'node:assert/strict';
import { createState, applyEvent, restoreHistory, mergeTurns, acceptTurn } from '../public/state.js';
const user = (id = 'user', text = 'Use the light screenshot') => ({ id, type: 'userMessage', content: [{ type: 'text', text }] });
const agent = { id: 'agent', type: 'agentMessage', text: 'Updated the screenshot.' };
function state() { const s = createState(); s.selectedId = 'demo'; s.thread = { id: 'demo' }; return s; }

test('partial completion preserves user items and full text, and history fills gaps in conversation order', () => {
  const s = state();
  applyEvent(s, { method: 'item/completed', params: { threadId: 'demo', turnId: 'turn', item: user() } });
  applyEvent(s, { method: 'item/completed', params: { threadId: 'demo', turnId: 'turn', item: agent } });
  applyEvent(s, { method: 'turn/completed', params: { threadId: 'demo', turn: { id: 'turn', status: 'completed', itemsView: 'summary', items: [{ ...agent, text: 'Updated…' }] } } });
  assert.deepEqual(s.turns[0].items, [user(), agent]);
  s.turns = mergeTurns(s.turns, [{ id: 'turn', items: [user(), user('steer'), agent] }]);
  assert.deepEqual(s.turns[0].items.map(i => i.id), ['user', 'steer', 'agent']);
  assert.equal(s.turns[0].status, 'completed');
});

test('lagging reconnect snapshots retain observed messages, terminal status, and streamed text', () => {
  const s = state(); s.turns = [{ id: 'turn', status: 'completed', completedAt: 20, items: [user(), agent] }];
  restoreHistory(s, [{ id: 'turn', status: 'inProgress', items: [{ ...agent, text: 'Updated' }] }], [], 4);
  assert.deepEqual(s.turns[0].items, [user(), agent]);
  assert.equal(s.turns[0].status, 'completed'); assert.equal(s.turns[0].completedAt, 20);
});

test('a start acknowledgement fills missing input after live start or completion without reviving work', () => {
  for (const status of ['inProgress', 'completed']) {
    const s = state(); s.turns = [{ id: 'turn', status, items: [agent] }];
    acceptTurn(s, { id: 'turn', status: 'inProgress', items: [user(), { ...agent, text: '' }] });
    assert.deepEqual(s.turns[0].items, [user(), agent]); assert.equal(s.turns[0].status, status);
    acceptTurn(s, { id: 'turn', status: 'inProgress', items: [user()] });
    assert.deepEqual(s.turns[0].items, [user(), agent]);
  }
});

test('history replay retains messages observed during loading without double-appending deltas', () => {
  const s = state();
  const events = [
    { method: 'item/completed', params: { threadId: 'demo', turnId: 'turn', item: user() }, bridgeSequence: 1 },
    { method: 'item/agentMessage/delta', params: { threadId: 'demo', turnId: 'turn', itemId: 'agent', delta: 'Updated' }, bridgeSequence: 2 },
  ];
  events.forEach(e => applyEvent(s, structuredClone(e)));
  restoreHistory(s, [{ id: 'turn', status: 'inProgress', items: [{ ...agent, text: 'Updated' }] }], events, 2);
  assert.deepEqual(s.turns[0].items.map(i => i.id), ['user', 'agent']);
  assert.equal(s.turns[0].items[1].text, 'Updated');
});
