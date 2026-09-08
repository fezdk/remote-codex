export function createState() {
  return { threads: [], selectedId: null, thread: null, turns: [], requests: new Map(), connected: false, loading: false, ready: false };
}

export function mergeTurns(existing, incoming) {
  const map = new Map(existing.map(turn => [turn.id, turn]));
  for (const turn of incoming) map.set(turn.id, { ...map.get(turn.id), ...turn });
  return [...map.values()].sort((a,b) => (a.startedAt ?? 0) - (b.startedAt ?? 0) || a.id.localeCompare(b.id));
}

export function activeTurn(state) {
  return state.turns.findLast(turn => turn.status === 'inProgress');
}

export function isWorking(state) {
  return Boolean(activeTurn(state) || state.thread?.status?.type === 'active');
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
  if (['turn/completed','thread/closed'].includes(message.method)) {
    for (const [key, request] of state.requests) {
      if (request.params?.threadId === p.threadId && (!p.turn || request.params.turnId === p.turn.id)) state.requests.delete(key);
    }
  }
  if (p.threadId !== state.selectedId) return;
  if (message.method === 'turn/started' || message.method === 'turn/completed') {
    const old = state.turns.find(t => t.id === p.turn.id);
    state.turns = mergeTurns(state.turns, [{ ...p.turn, items: p.turn.items?.length ? p.turn.items : old?.items || [] }]);
    if (state.thread) state.thread.status = { type: message.method === 'turn/started' ? 'active' : 'idle' };
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
