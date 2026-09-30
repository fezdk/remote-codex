import { inputImages } from './media.js';
import { t, errorText } from './i18n.js';
import { activeTurn, isWorking, acceptTurn, createSteerTracker, userMessageClientId, userMessageHasContent } from './state.js';
const $ = id => document.getElementById(id);
const textOf = item => (item.input || []).filter(part => part.type === 'text').map(part => part.text).join('\n');
const textOnly = item => item.input?.length && item.input.every(part => ['text', 'skill'].includes(part.type) || ['image', 'localImage'].includes(part.type) && part.remoteImage?.id);
const imagesOf = item => inputImages(item.input);
const imageIds = item => imagesOf(item).map(image => image.id);
const node = (tag, cls, text) => { const el = document.createElement(tag); el.className = cls; if (text != null) el.textContent = text; return el; };
const clientId = () => [...crypto.getRandomValues(new Uint8Array(16))].map(n => n.toString(16).padStart(2, '0')).join('');

export function initQueue({ media, api, getState, notice, renderApp, getDraft, saveDraft, skillsFor = () => [], handleCommand = () => false, isSettingsBusy = () => false, refreshHistory = () => {} }) {
  let threadId, items = [], revision = 0, generation = 0, failure, more = false, timer;
  const pending = new Map(), failed = new Map(), editing = new Map(), busy = new Set();
  const steers = createSteerTracker();
  const workContext = () => ({ turnId: activeTurn(getState())?.id, working: isWorking(getState()) });
  function reconcileEditing() {
    const edit = editing.get(threadId), current = workContext();
    if (edit && current.working && (!edit.working || current.turnId && current.turnId !== edit.turnId)) editing.delete(threadId);
  }
  function draft(text, mode, context = workContext(), images = []) {
    const prior = editing.get(threadId)?.prior ?? $('message').value;
    const priorImages = editing.get(threadId)?.priorImages ?? media.snapshot(threadId);
    const displaced = $('message').value, displacedImages = media.snapshot(threadId);
    if (displaced && displaced !== text || displacedImages.length && JSON.stringify(displacedImages.map(i => i.id)) !== JSON.stringify(images.map(i => i.id))) failed.set(threadId, [...failed.get(threadId) || [], { id: clientId(), input: [{ type: 'text', text: displaced }, ...media.parts(threadId)], recoveryKey: 'queue.savedDraft' }]);
    // A recalled/consumed message is an ordinary new draft, never an editable sent message.
    if (mode === 'edit') editing.set(threadId, { mode, prior, priorImages, ...context });
    else editing.delete(threadId);
    media.set(threadId, images);
    $('message').value = text; saveDraft(threadId, text); $('message').focus(); renderApp();
  }
  function render() {
    reconcileEditing();
    const state = getState(), active = activeTurn(state), working = isWorking(state), submission = pending.get(threadId);
    const delivered = new Set(state.turns.flatMap(turn => turn.items || []).filter(userMessageHasContent).map(userMessageClientId).filter(Boolean));
    if (submission && delivered.has(submission.id)) submission.received = true;
    // A queue snapshot can lag behind delivery; the conversation is sufficient
    // acknowledgement even if the HTTP reply or queue-changed event is late.
    items = items.filter(item => !delivered.has(item.clientUserMessageId));
    if (failed.has(threadId)) failed.set(threadId, failed.get(threadId).filter(item => !delivered.has(item.id)));
    const flight = submission?.received || submission?.steer || items.some(item => item.clientUserMessageId === submission?.id) ? null : submission;
    const fragment = document.createDocumentFragment();
    const disabled = !state.connected || !state.ready || Boolean(submission) || busy.has(threadId) || media.busy(threadId) || isSettingsBusy() || state.thread?.canAcceptDirectInput === false;
    function card(item, status, actions) {
      const row = node('div', 'queued-message'); row.dataset.queueId = item.id;
      row.append(node('div', 'queue-status', status), node('p', 'queue-text', textOf(item)));
      if (imagesOf(item).length) row.append(media.gallery(imagesOf(item), true, `queue:${item.id}`));
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
    for (const item of failed.get(threadId) || []) card(item, t(item.recoveryKey || 'queue.failed'), [['queue.restore', () => { failed.set(threadId, failed.get(threadId).filter(other => other !== item)); draft(textOf(item), 'resubmit', workContext(), imagesOf(item)); }]]);
    const hasCards = fragment.childNodes.length > 0;
    $('queue-list').replaceChildren(fragment);
    $('queue-area').hidden = !hasCards && !failure && !more;
    $('queue-error').textContent = failure ? `${t('queue.unsupported')} ${errorText(failure)}` : more ? t('queue.more') : '';
    const mode = editing.get(threadId)?.mode;
    $('edit-mode').hidden = !mode;
    $('done-editing').disabled = media.busy(threadId);
    $('edit-mode-label').textContent = mode ? t(mode === 'edit' ? 'queue.editing' : 'queue.resubmit') : '';
    $('attach-image').disabled = !state.connected || !state.ready || state.loading || busy.has(threadId) || state.thread?.canAcceptDirectInput === false;
    $('send').disabled = disabled || media.busy(threadId) || state.loading || (!$('message').value.trim() && !media.has(threadId)) || Boolean(working && failure);
    $('send').setAttribute('aria-label', t(working ? 'queue.add' : 'session.send'));
    $('send').title = $('send').getAttribute('aria-label');
    $('steer').hidden = !working;
    $('steer').disabled = disabled || media.busy(threadId) || !active || (!$('message').value.trim() && !media.has(threadId));
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
      if (threadId === id) { draft(textOf(item), result.deleted ? 'edit' : 'resubmit', context, imagesOf(item)); if (!result.deleted) notice(t('queue.noLongerQueued')); }
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
        submission = { ...item, id: item.clientUserMessageId || clientId(), steer: true, turnId: turn.id };
        steers.track(id, submission, turns); pending.set(id, submission);
        if (threadId === id) { items = items.filter(other => other.id !== item.id); renderApp(true); }
        await api(`/api/threads/${encodeURIComponent(id)}/message`, { text: textOf(item), images: imageIds(item), clientId: submission.id, turnId: turn.id, skills: item.input.filter(part => part.type === 'skill').map(part => part.name) });
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
    if (handleCommand()) return;
    const epoch = generation;
    const state = getState(), id = threadId, text = $('message').value, turn = activeTurn(state);
    if ((steer ? $('steer') : $('send')).disabled || media.busy(id) || (!text.trim() && !media.has(id))) return;
    const attachments = media.snapshot(id);
    const item = { id: clientId(), input: [{ type: 'text', text }, ...media.parts(id)], ...(steer ? { steer: true, turnId: turn.id } : {}) };
    if (steer) steers.track(id, item, state.turns);
    pending.set(id, item); renderApp(true);
    try {
      const queue = isWorking(state) && !steer;
      const response = await api(`/api/threads/${encodeURIComponent(id)}/${queue ? 'queue' : 'message'}`, { text, ...(attachments.length ? { images: attachments.map(image => image.id) } : {}), clientId: item.id, skills: skillsFor(text), ...(!queue && steer && turn ? { turnId: turn.id } : {}) });
      if (epoch !== generation) return;
      item.confirmed = true;
      media.clearSent(id, attachments);
      if (getDraft(id) === text) saveDraft(id, '');
      editing.delete(id);
      if (threadId === id) {
        if ($('message').value === text) $('message').value = '';
        if (response.turn) acceptTurn(state, response.turn);
        if (!queue) refreshHistory();
        $('message').focus();
      }
    } catch (error) {
      if (epoch === generation) {
        if (steer) steers.remove(id, item);
        if (!item.received && (getDraft(id) !== text || attachments.some(image => !media.list(id).includes(image)))) failed.set(id, [...failed.get(id) || [], item]);
        notice(error);
      }
    }
    finally { if (epoch === generation) { pending.delete(id); renderApp(threadId === id); if (threadId === id) await refresh(); } }
  }
  $('steer').onclick = () => submit(true);
  $('done-editing').onclick = () => { const edit = editing.get(threadId); draft(edit?.prior || '', 'resubmit', workContext(), edit?.priorImages || []); };
  return { render, refresh, submit, isBusy: () => pending.has(threadId) || busy.has(threadId), messages() { steers.reconcile(threadId, getState().turns); return steers.list(threadId); }, restoreDraft(text) { const displaced = $('message').value; if (displaced && displaced !== text) failed.set(threadId, [...failed.get(threadId) || [], { id: clientId(), input: [{ type: 'text', text: displaced }], recoveryKey: 'queue.savedDraft' }]); $('message').value = text; saveDraft(threadId, text); editing.delete(threadId); $('message').focus(); renderApp(); }, reset() { ++generation; clearTimeout(timer); pending.clear(); steers.reset(); failed.clear(); editing.clear(); busy.clear(); failure = null; more = false; items = []; threadId = null; ++revision; render(); }, selectThread(id) { if (id !== threadId) { threadId = id; items = []; failure = null; more = false; ++revision; } render(); }, event(message) {
    const id = message.params?.threadId;
    const edit = editing.get(id);
    if (edit && (message.method === 'turn/started' && message.params.turn.id !== edit.turnId || message.method === 'thread/status/changed' && message.params.status.type === 'active' && !edit.working)) editing.delete(id);
    const submission = pending.get(id), item = message.params?.item;
    if (['item/started', 'item/completed'].includes(message.method)) steers.observe(id, message.params.turnId, item);
    if (message.params?.turn) steers.reconcile(id, [message.params.turn]);
    if (submission && message.params?.turn?.items?.some(item => userMessageHasContent(item) && userMessageClientId(item) === submission.id && textOf({ input: item.content }) === textOf(submission))) submission.received = true;
    if (submission && !submission.steer && ['item/started', 'item/completed'].includes(message.method) && userMessageHasContent(item) && (!userMessageClientId(item) || item.clientId === submission.id) && textOf({ input: item.content }) === textOf(submission)) {
      submission.received = true;
      editing.delete(id);
    }
    if (submission?.received) editing.delete(id);
    if (id === threadId && ['thread/queue/changed', 'turn/completed'].includes(message.method)) { clearTimeout(timer); timer = setTimeout(refresh, 80); }
  }, keydown(event) {
    if (event.key !== 'ArrowUp' || event.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || !getState().ready || !getState().connected || $('message').value || media.has(threadId) || busy.has(threadId) || pending.has(threadId)) return;
    event.preventDefault();
    const queued = items.findLast(textOnly);
    if (queued) { edit(queued); return; }
    const sentSteer = steers.list(threadId).findLast(item => item.confirmed);
    if (sentSteer) { draft(textOf(sentSteer), 'resubmit', workContext(), imagesOf(sentSteer)); return; }
    const previous = getState().turns.flatMap(turn => turn.items || []).findLast(item => item.type === 'userMessage' && textOnly({ input: item.content }));
    if (previous) draft(previous.content.filter(part => part.type === 'text').map(part => part.text).join('\n'), 'resubmit', workContext(), inputImages(previous.content));
  } };
}
