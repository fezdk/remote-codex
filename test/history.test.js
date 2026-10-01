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

test('client IDs reconcile live items, snapshots and late acknowledgements before completion', () => {
  for (const reverse of [false, true]) {
    const live = { ...user('live'), clientId: 'submission' }, stored = { ...user('stored'), clientId: 'submission' };
    const [first, second] = reverse ? [stored, live] : [live, stored];
    const s = state();
    applyEvent(s, { method: 'item/completed', params: { threadId: 'demo', turnId: 'turn', item: first } });
    restoreHistory(s, [{ id: 'turn', status: 'inProgress', items: [second, agent] }], [], 0);
    applyEvent(s, { method: 'item/completed', params: { threadId: 'demo', turnId: 'turn', item: second } });
    assert.deepEqual(s.turns[0].items, [first, agent]);
    acceptTurn(s, { id: 'turn', status: 'inProgress', items: [second] });
    assert.equal(s.turns[0].items.filter(item => item.type === 'userMessage').length, 1);
    assert.equal(s.turns[0].status, 'inProgress');
  }
});

test('item identity preserves deliberate repeated text and collapses duplicates within snapshots', () => {
  const first = { ...user('first'), clientId: 'one' }, second = { ...user('second'), clientId: 'two' };
  const items = [first, first, { ...first, id: 'alias' }, second, user('legacy-one'), user('legacy-two')];
  const merged = mergeTurns([], [{ id: 'turn', items }]);
  assert.deepEqual(merged[0].items.map(item => item.id), ['first', 'second', 'legacy-one', 'legacy-two']);
  const summary = { ...first, id: 'other-alias', content: [] };
  assert.deepEqual(mergeTurns(merged, [{ id: 'turn', itemsView: 'summary', items: [summary] }])[0].items, merged[0].items);
  const nullId = mergeTurns(merged, [{ id: 'turn', items: [{ ...first, clientId: null }] }]);
  assert.equal(nullId[0].items[0].clientId, 'one');
});

test('reconstructed history and live agent answers reconcile in either order and retain image metadata', () => {
  const live = { ...agent, id: 'msg_native', text: 'Preview: [image](/synthetic/preview.png)', phase: 'commentary' };
  const stored = { ...live, id: 'item-42', remoteImageLinks: [{ markdown: '[image](/synthetic/preview.png)', image: { id: 'synthetic-image' } }] };
  for (const reverse of [false, true]) {
    const s = state(), [first, second] = reverse ? [stored, live] : [live, stored];
    applyEvent(s, { method: 'item/completed', params: { threadId: 'demo', turnId: 'turn', item: first } });
    restoreHistory(s, [{ id: 'turn', status: 'inProgress', items: [second] }], [], 0);
    assert.equal(s.turns[0].items.length, 1);
    assert.deepEqual(s.turns[0].items[0].remoteImageLinks, stored.remoteImageLinks);
    // A later partial start with either ID must not create a new bubble or erase text.
    for (const id of [live.id, stored.id]) {
      applyEvent(s, { method: 'item/started', params: { threadId: 'demo', turnId: 'turn', item: { id, type: 'agentMessage', text: '' } } });
      assert.equal(s.turns[0].items.length, 1);
      assert.equal(s.turns[0].items[0].text, live.text);
    }
    applyEvent(s, { method: 'item/agentMessage/delta', params: { threadId: 'demo', turnId: 'turn', itemId: second.id, delta: ' More.' } });
    assert.equal(s.turns[0].items.length, 1);
    assert.equal(s.turns[0].items[0].text, live.text + ' More.');
    restoreHistory(s, [{ id: 'turn', status: 'inProgress', items: [{ ...stored, text: live.text + ' More.' }] }], [], 0);
    assert.equal(s.turns[0].items.length, 1);
  }
});

test('reconstructed answer matching is one-to-one and does not deduplicate intentional repetitions', () => {
  const live = [1, 2].map(n => ({ ...agent, id: `msg_${n}` }));
  const stored = [1, 2].map(n => ({ ...agent, id: `item-${n}` }));
  for (const [first, second] of [[live, stored], [stored, live]]) {
    let turns = mergeTurns([], [{ id: 'turn', items: first }]);
    turns = mergeTurns(turns, [{ id: 'turn', items: second }]);
    assert.equal(turns[0].items.length, 2);
    turns = mergeTurns(turns, [{ id: 'turn', items: [...second, { ...agent, id: 'msg_new' }] }]);
    assert.equal(turns[0].items.length, 3);
  }
  assert.equal(mergeTurns([], [{ id: 'turn', items: [...live, ...stored] }])[0].items.length, 4);
  assert.equal(mergeTurns([{ id: 'one', items: live }], [{ id: 'two', items: stored }]).length, 2);
  for (const text of ['', ' ', 'Updated the']) {
    assert.equal(mergeTurns([{ id: 'turn', items: [agent] }], [{ id: 'turn', items: [{ ...agent, id: 'item-1', text }] }])[0].items.length, 2);
  }
  assert.equal(mergeTurns([{ id: 'turn', items: [{ ...agent, phase: 'commentary' }] }], [{ id: 'turn', items: [{ ...agent, id: 'item-1', phase: 'final_answer' }] }])[0].items.length, 2);
});

test('user aliases still reconcile when subsequent events omit the client ID', () => {
  const s = state();
  s.turns = mergeTurns([{ id: 'turn', items: [{ ...user('live'), clientId: 'client' }] }], [{ id: 'turn', items: [{ ...user('stored'), clientId: 'client' }] }]);
  applyEvent(s, { method: 'item/completed', params: { threadId: 'demo', turnId: 'turn', item: user('stored') } });
  assert.equal(s.turns[0].items.length, 1);
  assert.equal(s.turns[0].items[0].clientId, 'client');
});

test('completion joins a partial live answer with its full reconstructed snapshot', () => {
  const s = state();
  s.turns = [{ id: 'turn', items: [{ ...agent, id: 'msg_stream', text: 'Updated' }] }];
  restoreHistory(s, [{ id: 'turn', items: [{ ...agent, id: 'item-42' }] }], [], 0);
  applyEvent(s, { method: 'item/completed', params: { threadId: 'demo', turnId: 'turn', item: { ...agent, id: 'msg_stream' } } });
  assert.equal(s.turns[0].items.length, 1);
  assert.equal(s.turns[0].items[0].text, agent.text);
  // A separate native answer with the same text remains a separate message.
  applyEvent(s, { method: 'item/completed', params: { threadId: 'demo', turnId: 'turn', item: { ...agent, id: 'msg_repeat' } } });
  assert.equal(s.turns[0].items.length, 2);
});
