import test from 'node:test';
import assert from 'node:assert/strict';
import { createState, applyEvent, restoreHistory, mergeTurns, timestampMs, turnTiming, messageTiming } from '../public/state.js';
const user = { id: 'user', type: 'userMessage', content: [] };
const steer = { id: 'steer', type: 'userMessage', content: [] };
const commentary = { id: 'commentary', type: 'agentMessage', text: 'Working' };
const final = { id: 'final', type: 'agentMessage', text: 'Done' };

test('task timing uses reported duration, falls back to server boundaries, and does not invent unknown times', () => {
  const task = { startedAt: 100, completedAt: 103, durationMs: 3456, status: 'completed' };
  assert.equal(turnTiming(task).duration, 3456);
  assert.equal(turnTiming({ ...task, durationMs: null }).duration, 3000);
  assert.equal(turnTiming({ ...task, status: 'interrupted' }).duration, 3456);
  assert.equal(turnTiming({ ...task, status: 'failed' }).duration, 3456);
  assert.equal(turnTiming({ startedAt: 100, status: 'inProgress' }, 105000).duration, 5000);
  assert.equal(turnTiming({ startedAt: 100, status: 'inProgress' }, 99000).duration, null);
  for (const value of [null, undefined, '100', NaN, Infinity, -1, 1e20]) assert.equal(timestampMs(value), null);
  assert.equal(timestampMs(0), 0);
  assert.equal(turnTiming({ status: 'completed', durationMs: 0 }).duration, 0);
  assert.equal(turnTiming({ status: 'completed', startedAt: 100, completedAt: 99 }).duration, null);
  assert.equal(turnTiming({ status: 'completed', durationMs: Infinity }).duration, null);
});

test('message timing separates task boundaries from local observations and never dates history at load time', () => {
  const state = createState(); state.selectedId = 'demo';
  const turn = { id: 'turn', status: 'completed', startedAt: 100, completedAt: 200, items: [user, commentary, steer, final] };
  restoreHistory(state, [turn], [], 0);
  assert.deepEqual(messageTiming(state, turn, user), { at: 100000, source: 'start' });
  assert.deepEqual(messageTiming(state, turn, final), { at: 200000, source: 'end' });
  assert.equal(messageTiming(state, turn, commentary), null); assert.equal(messageTiming(state, turn, steer), null);
  applyEvent(state, { method: 'item/started', params: { threadId: 'demo', turnId: 'turn', item: commentary }, bridgeSequence: 1 });
  const observed = messageTiming(state, turn, commentary);
  assert.equal(observed.source, 'received'); assert.equal(typeof observed.at, 'number');
  applyEvent(state, { method: 'item/completed', params: { threadId: 'demo', turnId: 'turn', item: commentary }, bridgeSequence: 2 });
  restoreHistory(state, [turn], [], 2);
  assert.deepEqual(messageTiming(state, turn, commentary), observed);
  state.selectedId = 'other'; assert.equal(messageTiming(state, turn, commentary), null);
  assert.equal(createState().messageTimes.size, 0);
});

test('an item arriving before its turn does not fabricate a server start and late null metadata preserves known timing', () => {
  const state = createState(); state.selectedId = 'demo';
  applyEvent(state, { method: 'item/agentMessage/delta', params: { threadId: 'demo', turnId: 'turn', itemId: 'commentary', delta: 'hello' } });
  assert.equal(turnTiming(state.turns[0]).start, null); assert.equal(turnTiming(state.turns[0]).duration, null);
  const complete = { id: 'turn', status: 'completed', startedAt: 100, completedAt: 120, durationMs: 20000, items: [] };
  state.turns = mergeTurns(state.turns, [complete]);
  state.turns = mergeTurns(state.turns, [{ ...complete, status: 'inProgress', startedAt: null, completedAt: null, durationMs: null }]);
  assert.deepEqual(turnTiming(state.turns[0]), { start: 100000, end: 120000, duration: 20000, active: false, estimated: false });
});

test('local observation cache is bounded and snapshot-covered events do not get new observation times', () => {
  const state = createState(); state.selectedId = 'other';
  for (let i = 0; i < 5002; i++) applyEvent(state, { method: 'item/started', params: { threadId: 'demo', turnId: 'turn', item: { ...commentary, id: String(i) } }, bridgeSequence: i + 1 });
  assert.equal(state.messageTimes.size, 5000);
  state.snapshotSequence = 9000;
  applyEvent(state, { method: 'item/started', params: { threadId: 'demo', turnId: 'turn', item: { ...commentary, id: 'old' } }, bridgeSequence: 8000 });
  assert.equal(state.messageTimes.size, 5000);
});
