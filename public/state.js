export function createState() {
  return { threads: [], selectedId: null, thread: null, turns: [], requests: new Map(), connected: false, loading: false, ready: false, snapshotSequence: 0 };
}

// Turn notifications can contain only some items. Merge by ID without discarding
// streamed messages, and insert newly loaded history before its next known item.
function mergeItems(existing = [], incoming = [], summary = false) {
  const known = new Map(existing.map(item => [item.id, item]));
  const before = new Map(); let additions = [];
  for (const item of incoming) {
    if (!known.has(item.id)) { additions.push(item); continue; }
    before.set(item.id, [...before.get(item.id) || [], ...additions]); additions = [];
    const old = known.get(item.id);
    known.set(item.id, summary ? { ...item, ...old } : { ...old, ...item });
  }
  return existing.flatMap(item => [...before.get(item.id) || [], known.get(item.id)]).concat(additions);
}

export function mergeTurns(existing, incoming) {
  const map = new Map(existing.map(turn => [turn.id, turn]));
  for (const turn of incoming) {
    const old = map.get(turn.id);
    const merged = { ...old, ...turn, items: mergeItems(old?.items, turn.items, turn.itemsView === 'summary') };
    if (old && ['completed', 'interrupted', 'failed'].includes(old.status) && turn.status === 'inProgress') {
      for (const field of ['status', 'error', 'completedAt', 'durationMs']) merged[field] = old[field];
    }
    map.set(turn.id, merged);
  }
  return [...map.values()].sort((a,b) => (a.startedAt ?? 0) - (b.startedAt ?? 0) || a.id.localeCompare(b.id));
}

// A start acknowledgement can follow live items or even turn completion.
export function acceptTurn(state, turn) {
  const live = state.turns.find(candidate => candidate.id === turn.id);
  state.turns = mergeTurns(state.turns.filter(candidate => candidate.id !== turn.id), mergeTurns([turn], live ? [live] : []));
}

export function activeTurn(state) {
  return state.turns.findLast(turn => turn.status === 'inProgress');
}

export function isWorking(state) {
  return Boolean(activeTurn(state) || state.thread?.status?.type === 'active');
}

// A steer RPC acknowledgement may arrive well before its userMessage event.
// Keep local display entries separate from authoritative conversation history.
export function createSteerTracker() {
  const entries = new Map(), seen = new Map();
  let existingItems = new WeakMap();
  const text = parts => (parts || []).filter(part => part.type === 'text').map(part => part.text).join('\n');
  const key = (turnId, itemId) => JSON.stringify([turnId, itemId]);
  function remove(threadId, entry) {
    const remaining = (entries.get(threadId) || []).filter(candidate => candidate !== entry);
    if (remaining.length) entries.set(threadId, remaining);
    else entries.delete(threadId);
  }
  function observe(threadId, turnId, item) {
    if (item?.type !== 'userMessage' || !item.id || !entries.has(threadId)) return;
    const observed = seen.get(threadId), itemKey = key(turnId, item.id);
    if (observed.has(itemKey)) return;
    const entry = entries.get(threadId).find(candidate => !existingItems.get(candidate).has(itemKey) && candidate.turnId === turnId && text(candidate.input) === text(item.content));
    // An item can be announced before its text is complete. Only consume a match.
    if (!entry) return;
    observed.add(itemKey);
    entry.received = true;
    remove(threadId, entry);
  }
  function reconcile(threadId, turns) {
    for (const turn of turns) for (const item of turn.items || []) observe(threadId, turn.id, item);
  }
  return {
    track(threadId, entry, turns) {
      reconcile(threadId, turns);
      if (!seen.has(threadId)) seen.set(threadId, new Set());
      existingItems.set(entry, new Set(turns.flatMap(turn => (turn.items || []).filter(item => item.type === 'userMessage').map(item => key(turn.id, item.id)))));
      entries.set(threadId, [...entries.get(threadId) || [], entry]);
    },
    observe, reconcile, remove,
    list: threadId => entries.get(threadId) || [],
    reset() { entries.clear(); seen.clear(); existingItems = new WeakMap(); },
  };
}

// RPC arrival order is not a snapshot watermark. Terminal events may precede a stale RPC reply.
export function restoreHistory(state, snapshot, events, responseSequence = 0) {
  const live = state.turns;
  state.turns = mergeTurns(live.filter(turn => snapshot.some(candidate => candidate.id === turn.id)), snapshot);
  state.snapshotSequence = responseSequence;
  for (const event of events) {
    if (event.id !== undefined) continue;
    applyEvent(state, event);
  }
  // Preserve a known live prefix without replaying overlapping deltas twice.
  for (const turn of state.turns) for (const item of turn.items || []) {
    const current = live.find(candidate => candidate.id === turn.id)?.items?.find(candidate => candidate.id === item.id);
    for (const field of ['text', 'aggregatedOutput']) {
      if (typeof item[field] === 'string' && typeof current?.[field] === 'string' && current[field].startsWith(item[field])) item[field] = current[field];
    }
  }
  if (activeTurn(state) && state.thread) state.thread.status = { ...state.thread.status, type: 'active' };
}

export function applyEvent(state, message) {
  const p = message.params || {};
  if (message.id !== undefined) {
    state.requests.set(JSON.stringify(message.id), message);
    return;
  }
  if (message.method === 'serverRequest/resolved') state.requests.delete(JSON.stringify(p.requestId));
  if (message.method === 'thread/started') {
    const index = state.threads.findIndex(t => t.id === p.thread.id);
    if (index < 0) state.threads.unshift(p.thread);
    else state.threads[index] = { ...state.threads[index], ...p.thread };
  }
  if (message.method === 'thread/status/changed') {
    const thread = state.threads.find(t => t.id === p.threadId);
    if (thread) thread.status = p.status;
    if (state.thread?.id === p.threadId) state.thread.status = p.status;
  }
  if (message.method === 'thread/name/updated') {
    const thread = state.threads.find(t => t.id === p.threadId);
    if (thread) thread.name = p.threadName;
    if (state.thread?.id === p.threadId) state.thread.name = p.threadName;
  }
  if (message.method === 'thread/settings/updated' && p.threadSettings) {
    const update = { model: p.threadSettings.model, reasoningEffort: p.threadSettings.effort };
    const thread = state.threads.find(t => t.id === p.threadId);
    if (thread) Object.assign(thread, update);
    if (state.thread?.id === p.threadId) Object.assign(state.thread, update);
  }
  if (['turn/completed','thread/closed'].includes(message.method)) {
    for (const [key, request] of state.requests) {
      if (request.params?.threadId === p.threadId && (!p.turn || request.params.turnId === p.turn.id)) state.requests.delete(key);
    }
  }
  if (p.threadId !== state.selectedId) return;
  if (message.bridgeSequence <= state.snapshotSequence) {
    const turn = state.turns.find(turn => turn.id === (p.turnId || p.turn?.id));
    if (message.method.endsWith('Delta') || message.method.endsWith('/delta')) return;
    if (message.method === 'turn/started' && turn) return;
    if (message.method === 'item/started' && turn?.items?.some(item => item.id === p.item?.id)) return;
  }
  if (message.method === 'turn/started' || message.method === 'turn/completed') {
    const old = state.turns.find(t => t.id === p.turn.id);
    state.turns = mergeTurns(state.turns, [{ ...p.turn, items: p.turn.items?.length ? p.turn.items : old?.items || [] }]);
    if (state.thread) state.thread.status = { type: activeTurn(state) ? 'active' : 'idle' };
  }
  if (p.turnId && (message.method.startsWith('item/') || message.method === 'error')) {
    let turn = state.turns.find(t => t.id === p.turnId);
    if (!turn) { turn = { id: p.turnId, status: 'inProgress', items: [], startedAt: Date.now()/1000 }; state.turns.push(turn); }
    if (p.item) {
      const index = turn.items.findIndex(item => item.id === p.item.id);
      if (index < 0) turn.items.push(p.item);
      else turn.items[index] = { ...turn.items[index], ...p.item };
    }
    if (p.itemId && typeof p.delta === 'string') {
      const types = { 'item/agentMessage/delta': ['agentMessage','text'], 'item/commandExecution/outputDelta': ['commandExecution','aggregatedOutput'], 'item/plan/delta': ['plan','text'], 'item/reasoning/summaryTextDelta': ['reasoning','summary'] };
      const spec = types[message.method];
      if (spec) {
        let item = turn.items.find(item => item.id === p.itemId);
        if (!item) { item = { id: p.itemId, type: spec[0] }; turn.items.push(item); }
        if (spec[1] === 'summary') { item.summary ||= []; item.summary[p.summaryIndex || 0] = (item.summary[p.summaryIndex || 0] || '') + p.delta; }
        else item[spec[1]] = (item[spec[1]] || '') + p.delta;
      }
    }
    if (message.method === 'error') turn.error = p.error;
  }
}

export function title(thread, fallback = '') { return thread?.name || thread?.preview?.split('\n')[0] || fallback; }
export function project(path, fallback = '') { return path?.replace(/\/$/,'').split('/').pop() || fallback; }
