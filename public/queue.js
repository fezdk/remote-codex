import { t, errorText } from './i18n.js';
import { activeTurn, isWorking, applyEvent, createSteerTracker } from './state.js';
const $ = id => document.getElementById(id);
const textOf = item => (item.input || []).filter(part => part.type === 'text').map(part => part.text).join('\n');
const textOnly = item => item.input?.length && item.input.every(part => part.type === 'text');
const node = (tag, cls, text) => { const el = document.createElement(tag); el.className = cls; if (text != null) el.textContent = text; return el; };
const clientId = () => [...crypto.getRandomValues(new Uint8Array(16))].map(n => n.toString(16).padStart(2, '0')).join('');

export function initQueue({ api, getState, notice, renderApp, getDraft, saveDraft }) {
  let threadId, items = [], revision = 0, generation = 0, failure, more = false, timer;
  const pending = new Map(), failed = new Map(), editing = new Map(), busy = new Set();
  const steers = createSteerTracker();
  const workContext = () => ({ turnId: activeTurn(getState())?.id, working: isWorking(getState()) });
  function reconcileEditing() {
    const edit = editing.get(threadId), current = workContext();
    if (edit && current.working && (!edit.working || current.turnId && current.turnId !== edit.turnId)) editing.delete(threadId);
  }
  function draft(text, mode, context = workContext()) {
    const prior = editing.get(threadId)?.prior ?? $('message').value;
    const displaced = $('message').value;
    if (displaced && displaced !== text) failed.set(threadId, [...failed.get(threadId) || [], { id: clientId(), input: [{ type: 'text', text: displaced }], recoveryKey: 'queue.savedDraft' }]);
    // A recalled/consumed message is an ordinary new draft, never an editable sent message.
    if (mode === 'edit') editing.set(threadId, { mode, prior, ...context });
    else editing.delete(threadId);
    $('message').value = text; saveDraft(threadId, text); $('message').focus(); renderApp();
  }
  function render() {
    reconcileEditing();
    const state = getState(), active = activeTurn(state), working = isWorking(state), submission = pending.get(threadId);
    const flight = submission?.received || submission?.steer ? null : submission;
    const fragment = document.createDocumentFragment();
    const disabled = !state.connected || !state.ready || Boolean(submission) || busy.has(threadId) || state.thread?.canAcceptDirectInput === false;
    function card(item, status, actions) {
      const row = node('div', 'queued-message'); row.dataset.queueId = item.id;
      row.append(node('div', 'queue-status', status), node('p', 'queue-text', textOf(item)));
      const buttons = node('div', 'queue-actions');
      for (const [key, action, unavailable] of actions) { const button = node('button', '', t(key)); button.type = 'button'; button.disabled = disabled || unavailable; button.onclick = action; buttons.append(button); }
      row.append(buttons); fragment.append(row);
    }
    for (const item of items) card(item, t('queue.waiting'), [
      ['queue.edit', () => edit(item), !textOnly(item)],
      [working ? 'queue.steer' : 'queue.start', () => deliver(item), working && (!active || !textOnly(item))],
      ['queue.cancel', () => cancel(item)],
    ]);
    if (flight) card(flight, t('queue.sending'), []);
    for (const item of failed.get(threadId) || []) card(item, t(item.recoveryKey || 'queue.failed'), [['queue.restore', () => { failed.set(threadId, failed.get(threadId).filter(other => other !== item)); draft(textOf(item), 'resubmit'); }]]);
    $('queue-list').replaceChildren(fragment);
    $('queue-area').hidden = !fragment.childNodes.length && !items.length && !flight && !(failed.get(threadId)?.length) && !failure;
    $('queue-error').textContent = failure ? `${t('queue.unsupported')} ${errorText(failure)}` : more ? t('queue.more') : '';
    const mode = editing.get(threadId)?.mode;
    $('edit-mode').hidden = !mode;
    $('edit-mode-label').textContent = mode ? t(mode === 'edit' ? 'queue.editing' : 'queue.resubmit') : '';
    $('send').disabled = disabled || state.loading || !$('message').value.trim() || Boolean(working && failure);
    $('send').setAttribute('aria-label', t(working ? 'queue.add' : 'session.send'));
    $('send').title = $('send').getAttribute('aria-label');
    $('steer').hidden = !working;
    $('steer').disabled = disabled || !active || !$('message').value.trim();
    $('message').placeholder = t(working ? 'queue.placeholder' : 'session.placeholder');
    $('send-mode').textContent = t(working ? 'queue.mode' : 'session.defaults');
  }
  async function refresh() {
    if (!threadId || !getState().connected) return;
    const version = ++revision;
    try { const result = await api(`/api/threads/${encodeURIComponent(threadId)}/queue`); if (version !== revision) return; items = result.data; more = Boolean(result.nextCursor); failure = null; }
    catch (error) { if (version === revision) failure = error; }
    if (version === revision) render();
  }
  const endpoint = (id, item, action) => `/api/threads/${encodeURIComponent(id)}/queue/${encodeURIComponent(item.id)}/${action}`;
  async function edit(item) {
    const epoch = generation;
    const id = threadId, context = workContext(); busy.add(id); render();
    try {
      const result = await api(endpoint(id, item, 'delete'), {});
      if (epoch !== generation) return;
      if (threadId === id) { draft(textOf(item), result.deleted ? 'edit' : 'resubmit', context); if (!result.deleted) notice(t('queue.noLongerQueued')); }
      else if (result.deleted) failed.set(id, [...failed.get(id) || [], item]);
    } catch (error) {
      if (epoch !== generation) return;
      // Deletion may have succeeded even when its HTTP acknowledgement was lost.
      failed.set(id, [...failed.get(id) || [], item]);
      notice(error);
    }
    finally { if (epoch === generation) { busy.delete(id); if (threadId === id) await refresh(); render(); } }
  }
  async function cancel(item) {
    const epoch = generation;
    const id = threadId; busy.add(id); render();
    try { await api(endpoint(id, item, 'delete'), {}); }
    catch (error) { if (epoch === generation) notice(error); }
    finally { if (epoch === generation) { busy.delete(id); if (threadId === id) await refresh(); render(); } }
  }
  async function deliver(item) {
    const epoch = generation;
    const id = threadId, turns = getState().turns, turn = activeTurn(getState()); busy.add(id); render();
    let submission;
    let withdrawn = false;
    try {
      if (turn) {
        const result = await api(endpoint(id, item, 'delete'), {});
        if (epoch !== generation) return;
        if (!result.deleted) { notice(t('queue.noLongerQueued')); return; }
        withdrawn = true;
        submission = { ...item, id: clientId(), steer: true, turnId: turn.id };
        steers.track(id, submission, turns); pending.set(id, submission);
        if (threadId === id) { items = items.filter(other => other.id !== item.id); renderApp(true); }
        await api(`/api/threads/${encodeURIComponent(id)}/message`, { text: textOf(item), turnId: turn.id });
        if (epoch !== generation) return;
        submission.confirmed = true;
      } else await api(endpoint(id, item, 'start'), {});
    } catch (error) {
      if (epoch !== generation) return;
      // Never silently replay a possibly delivered message. Keep withdrawn text reviewable.
      if (submission) steers.remove(id, submission);
      if ((turn || withdrawn) && !submission?.received) failed.set(id, [...failed.get(id) || [], item]);
      notice(error);
    } finally { if (epoch === generation) { busy.delete(id); pending.delete(id); renderApp(threadId === id); if (threadId === id) await refresh(); } }
  }
  async function submit(steer = false) {
    const epoch = generation;
    const state = getState(), id = threadId, text = $('message').value, turn = activeTurn(state);
    if ((steer ? $('steer') : $('send')).disabled || !text.trim()) return;
    const item = { id: clientId(), input: [{ type: 'text', text }], ...(steer ? { steer: true, turnId: turn.id } : {}) };
    if (steer) steers.track(id, item, state.turns);
    pending.set(id, item); renderApp(true);
    try {
      const queue = isWorking(state) && !steer;
      const response = await api(`/api/threads/${encodeURIComponent(id)}/${queue ? 'queue' : 'message'}`, { text, ...(queue ? { clientId: item.id } : steer && turn ? { turnId: turn.id } : {}) });
      if (epoch !== generation) return;
      item.confirmed = true;
      if (getDraft(id) === text) saveDraft(id, '');
      editing.delete(id);
      if (threadId === id) {
        if ($('message').value === text) $('message').value = '';
        if (response.turn && !state.turns.some(t => t.id === response.turn.id)) applyEvent(state, { method: 'turn/started', params: { threadId: id, turn: response.turn } });
        $('message').focus();
      }
    } catch (error) {
      if (epoch === generation) {
        if (steer) steers.remove(id, item);
        if (getDraft(id) !== text) failed.set(id, [...failed.get(id) || [], item]);
        notice(error);
      }
    }
    finally { if (epoch === generation) { pending.delete(id); renderApp(threadId === id); if (threadId === id) await refresh(); } }
  }
  $('steer').onclick = () => submit(true);
  $('done-editing').onclick = () => { const prior = editing.get(threadId)?.prior || ''; draft(prior, 'resubmit'); };
  return { render, refresh, submit, messages() { steers.reconcile(threadId, getState().turns); return steers.list(threadId); }, restoreDraft(text) { draft(text, 'resubmit'); }, reset() { ++generation; clearTimeout(timer); pending.clear(); steers.reset(); failed.clear(); editing.clear(); busy.clear(); failure = null; more = false; items = []; threadId = null; ++revision; render(); }, selectThread(id) { if (id !== threadId) { threadId = id; items = []; failure = null; more = false; ++revision; } render(); }, event(message) {
    const id = message.params?.threadId;
    const edit = editing.get(id);
    if (edit && (message.method === 'turn/started' && message.params.turn.id !== edit.turnId || message.method === 'thread/status/changed' && message.params.status.type === 'active' && !edit.working)) editing.delete(id);
    const submission = pending.get(id), item = message.params?.item;
    if (['item/started', 'item/completed'].includes(message.method)) steers.observe(id, message.params.turnId, item);
    if (message.params?.turn) steers.reconcile(id, [message.params.turn]);
    if (submission && !submission.steer && ['item/started', 'item/completed'].includes(message.method) && item?.type === 'userMessage' && textOf({ input: item.content }) === textOf(submission)) {
      submission.received = true;
      editing.delete(id);
    }
    if (submission?.received) editing.delete(id);
    if (id === threadId && ['thread/queue/changed', 'turn/completed'].includes(message.method)) { clearTimeout(timer); timer = setTimeout(refresh, 80); }
  }, keydown(event) {
    if (event.key !== 'ArrowUp' || event.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || !getState().ready || !getState().connected || $('message').value || busy.has(threadId) || pending.has(threadId)) return;
    event.preventDefault();
    const queued = items.findLast(textOnly);
    if (queued) { edit(queued); return; }
    const sentSteer = steers.list(threadId).findLast(item => item.confirmed);
    if (sentSteer) { draft(textOf(sentSteer), 'resubmit'); return; }
    const previous = getState().turns.flatMap(turn => turn.items || []).findLast(item => item.type === 'userMessage' && item.content?.some(part => part.type === 'text'));
    if (previous) draft(previous.content.filter(part => part.type === 'text').map(part => part.text).join('\n'), 'resubmit');
  } };
}
