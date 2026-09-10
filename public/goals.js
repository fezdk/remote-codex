import { t, errorText } from './i18n.js';
import { activeTurn } from './state.js';

const $ = id => document.getElementById(id);
const fingerprint = goal => goal ? JSON.stringify([goal.objective, goal.status, goal.tokenBudget, goal.createdAt]) : null;
export function initGoals({ api, getState }) {
  const dialog = $('goal-dialog'), objective = $('goal-objective'), budget = $('goal-budget');
  let id = null, generation = 0, request = 0, revision = 0, goal = null, known = false, loading = false, error = '', dirty = false, draftVersion = null, clearVersion = null;
  const pending = new Set();
  const endpoint = threadId => `/api/threads/${encodeURIComponent(threadId)}/goal`;
  const version = () => fingerprint(goal);
  function fill() {
    objective.value = goal?.objective || ''; budget.value = goal?.tokenBudget ?? '';
    dirty = false; draftVersion = version();
  }
  function accept(value) {
    goal = value; known = true;
    if (!dirty) fill();
  }
  function render() {
    const state = getState(), busy = pending.has(id), enabled = Boolean(id && state.ready && state.connected);
    $('goal-button').disabled = !enabled;
    $('goal-button').title = goal ? `Goal · ${t(`goals.status.${goal.status}`)}` : 'Goal';
    $('goal-dot').hidden = !goal;
    $('goal-dot').dataset.status = goal?.status || '';
    if (!dialog.open) return;
    const ready = enabled && known && !busy && !loading;
    const conflict = dirty && draftVersion !== version();
    $('goal-state').textContent = !state.connected ? t('connection.disconnected') : loading ? t('tools.loading') : !known ? t('goals.unavailable') : goal ? t(`goals.status.${goal.status}`) : t('goals.empty');
    const facts = $('goal-facts'); facts.replaceChildren();
    const format = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? new Intl.NumberFormat(document.documentElement.lang).format(value) : t('tools.unknown');
    if (goal) {
      for (const [key, value] of [
        ['goals.tokens', format(goal.tokensUsed)],
        ['goals.budget', goal.tokenBudget === null ? t('goals.unlimited') : format(goal.tokenBudget)],
        ['goals.remaining', goal.tokenBudget === null ? '—' : format(Math.max(0, goal.tokenBudget - goal.tokensUsed))],
        ['goals.time', t('goals.seconds', { count: format(goal.timeUsedSeconds) })],
      ]) { const dt = document.createElement('dt'), dd = document.createElement('dd'); dt.textContent = t(key); dd.textContent = value; facts.append(dt, dd); }
    }
    $('goal-current').textContent = goal?.objective || '';
    $('goal-current').hidden = !goal || !dirty;
    $('goal-save').textContent = t(busy ? 'goals.saving' : goal ? 'goals.save' : 'goals.create');
    $('goal-save').disabled = !ready || conflict || !objective.value.trim() || goal && !dirty;
    objective.disabled = !ready; budget.disabled = !ready;
    $('goal-replace-note').hidden = !goal || objective.value.trim() === goal.objective;
    $('goal-actions').hidden = !goal;
    for (const [action, status] of [['pause', 'paused'], ['resume', 'active'], ['complete', 'complete'], ['blocked', 'blocked']]) {
      $( `goal-${action}`).disabled = !ready || !goal || goal.status === status;
    }
    $('goal-clear').disabled = !ready || !goal;
    $('goal-clear-yes').disabled = !ready || !goal || clearVersion !== version();
    $('goal-stop').disabled = !enabled || busy || !activeTurn(state);
    $('goal-refresh').disabled = !enabled || busy || loading;
    $('goal-error').textContent = error || (conflict ? t('goals.conflict') : '');
  }
  async function refresh(discard = false) {
    if (!id || !getState().connected) return;
    const current = generation, seq = ++request, observed = revision;
    loading = true; render();
    try {
      const result = await api(endpoint(id));
      if (current !== generation || seq !== request) return;
      if (observed === revision) accept(result.goal);
      if (discard) fill();
      error = '';
    } catch (failure) {
      if (current === generation && seq === request && observed === revision) { known = false; error = `${t('goals.unavailable')} ${errorText(failure)}`; }
    } finally { if (current === generation && seq === request) { loading = false; render(); } }
  }
  async function change(action, status) {
    if (!id || !known || pending.has(id) || !getState().ready || !getState().connected || loading) return;
    const current = generation, threadId = id, observed = revision, before = goal;
    const input = { action, version: action === 'create' || action === 'update' ? draftVersion : version() };
    if (action === 'create' || action === 'update') {
      if (! $('goal-form').reportValidity()) return;
      input.objective = objective.value.trim(); input.tokenBudget = budget.value === '' ? null : Number(budget.value);
    }
    if (status) input.status = status;
    if (action === 'clear') input.version = clearVersion;
    pending.add(threadId); error = ''; $('goal-clear-confirm').hidden = true; render();
    try {
      const result = await api(endpoint(threadId), input);
      if (current !== generation) return;
      if (revision === observed) accept(result.goal);
      if (action !== 'status') fill();
      else if (goal?.objective === before?.objective && goal?.tokenBudget === before?.tokenBudget && goal?.createdAt === before?.createdAt) draftVersion = version();
    } catch (failure) {
      if (current !== generation) return;
      // A lost acknowledgement can follow a successful mutation. Read back; never replay.
      await refresh();
      if (current === generation) error = `${t('goals.unconfirmed')} ${errorText(failure)}`;
    } finally { pending.delete(threadId); render(); }
  }
  function open() {
    if (!id || !getState().ready || !getState().connected) return;
    if (!dialog.open) dialog.showModal();
    render(); refresh();
  }
  objective.oninput = budget.oninput = () => { dirty = true; render(); };
  $('goal-button').onclick = open;
  $('goal-close').onclick = () => dialog.close();
  $('goal-refresh').onclick = () => refresh(true);
  $('goal-form').onsubmit = event => { event.preventDefault(); change(goal ? 'update' : 'create'); };
  for (const [action, status] of [['pause', 'paused'], ['resume', 'active'], ['complete', 'complete'], ['blocked', 'blocked']]) $( `goal-${action}`).onclick = () => change('status', status);
  $('goal-clear').onclick = () => { clearVersion = version(); render(); $('goal-clear-confirm').hidden = false; $('goal-clear-yes').focus(); };
  $('goal-clear-no').onclick = () => { $('goal-clear-confirm').hidden = true; };
  $('goal-clear-yes').onclick = () => change('clear');
  $('goal-stop').onclick = async () => {
    const turn = activeTurn(getState()), threadId = id, current = generation;
    if (!turn || !getState().ready || !getState().connected || pending.has(id)) return;
    pending.add(threadId); error = ''; render();
    try { await api(`/api/threads/${encodeURIComponent(threadId)}/interrupt`, { turnId: turn.id }); }
    catch (failure) { if (current === generation) error = `${t('goals.unconfirmed')} ${errorText(failure)}`; }
    finally { pending.delete(threadId); render(); }
  };
  return {
    open, render, refresh,
    selectThread(threadId) {
      if (id === threadId) return;
      ++generation; ++request; id = threadId; revision = 0; goal = null; known = false; loading = false; error = ''; fill();
      $('goal-clear-confirm').hidden = true; dialog.close(); render();
    },
    reset() { this.selectThread(null); pending.clear(); },
    event(message) {
      if (message.params?.threadId !== id) return;
      if (message.method === 'thread/goal/updated' || message.method === 'thread/goal/cleared') {
        ++revision;
        accept(message.method === 'thread/goal/cleared' ? null : message.params.goal);
        if (clearVersion !== version()) $('goal-clear-confirm').hidden = true;
        render();
      }
    },
  };
}
