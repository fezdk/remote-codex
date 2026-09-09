import test from 'node:test';
import assert from 'node:assert/strict';
import { createSteerTracker } from '../public/state.js';

const entry = (id, turnId = 'active') => ({ id, turnId, input: [{ type: 'text', text: 'same instruction' }] });
const message = id => ({ id, type: 'userMessage', content: [{ type: 'text', text: 'same instruction' }] });

test('steers remain visible until a matching new message arrives in the same thread and turn', () => {
  const tracker = createSteerTracker(), pending = entry('one');
  const history = [{ id: 'active', items: [message('old')] }];
  tracker.track('thread', pending, history);
  pending.confirmed = true;
  tracker.reconcile('thread', history);
  tracker.observe('other-thread', 'active', message('other'));
  tracker.observe('thread', 'other-turn', message('different-turn'));
  assert.deepEqual(tracker.list('thread'), [pending]);
  tracker.observe('thread', 'active', message('new'));
  assert.equal(pending.received, true); assert.deepEqual(tracker.list('thread'), []);
});

test('identical steers reconcile one-to-one across started/completed events and history refreshes', () => {
  const tracker = createSteerTracker(), first = entry('first'), second = entry('second');
  tracker.track('thread', first, []); tracker.track('thread', second, []);
  tracker.observe('thread', 'active', { id: 'one', type: 'userMessage', content: [] });
  assert.equal(tracker.list('thread').length, 2, 'an incomplete announcement cannot hide text');
  tracker.observe('thread', 'active', message('one'));
  tracker.observe('thread', 'active', message('one'));
  tracker.reconcile('thread', [{ id: 'active', items: [message('one')] }]);
  assert.deepEqual(tracker.list('thread'), [second]); assert.equal(second.received, undefined);
  tracker.reconcile('thread', [{ id: 'active', items: [message('one'), message('two')] }]);
  assert.equal(second.received, true); assert.equal(tracker.list('thread').length, 0);
});

test('failed steers can be withdrawn from the display and logout clears all thread state', () => {
  const tracker = createSteerTracker(), failed = entry('failed');
  tracker.track('one', failed, []); tracker.track('two', entry('retained'), []);
  tracker.remove('one', failed);
  assert.equal(tracker.list('one').length, 0); assert.equal(tracker.list('two').length, 1);
  tracker.reset(); assert.equal(tracker.list('two').length, 0);
});

test('a later submission does not hide an earlier incomplete conversation announcement', () => {
  const tracker = createSteerTracker(), first = entry('first'), second = entry('second');
  tracker.track('thread', first, []);
  const history = [{ id: 'active', items: [{ id: 'announced', type: 'userMessage', content: [] }] }];
  tracker.track('thread', second, history);
  tracker.observe('thread', 'active', message('announced'));
  assert.equal(first.received, true); assert.deepEqual(tracker.list('thread'), [second]);
  tracker.observe('thread', 'active', message('announced'));
  assert.deepEqual(tracker.list('thread'), [second]);
});
