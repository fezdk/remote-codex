import { t, errorText } from './i18n.js';
import { isWorking } from './state.js';

const $ = id => document.getElementById(id);
export function initModels({ api, getState, renderApp, notice, isQueueBusy }) {
  let catalog = [], loading = false, failure = null, needsRefresh = false, generation = 0, request = 0;
  const pending = new Map(), events = new Map();
  const endpoint = id => `/api/threads/${encodeURIComponent(id)}/settings`;
  const busy = () => pending.has(getState().selectedId);
  const effortLabel = effort => t(`models.effort.${effort}`, {}, effort);
  function options(select, values, selected) {
    const signature = JSON.stringify(values);
    if (select.dataset.options !== signature) {
      select.replaceChildren(...values.map(value => {
        const option = document.createElement('option'); option.value = value.value; option.textContent = value.label; option.title = value.title || ''; option.disabled = Boolean(value.disabled); return option;
      }));
      select.dataset.options = signature;
    }
    select.value = selected;
  }
  function render() {
    const state = getState(), current = state.thread, saving = pending.get(state.selectedId);
    const selectedModel = saving?.model ?? current?.model ?? '';
    const selectedEffort = saving ? saving.effort ?? '' : current?.reasoningEffort ?? '';
    const model = catalog.find(model => model.model === selectedModel);
    const modelOptions = catalog.map(model => ({ value: model.model, label: model.name, title: model.description }));
    if (!model) modelOptions.unshift({ value: selectedModel, label: selectedModel || t(loading ? 'models.loading' : 'models.choose'), disabled: true });
    options($('model-select'), modelOptions, selectedModel);
    const effortOptions = (model?.efforts || []).map(option => ({ value: option.effort, label: effortLabel(option.effort), title: option.description }));
    if (!effortOptions.some(option => option.value === selectedEffort)) effortOptions.unshift({ value: selectedEffort, label: selectedEffort ? effortLabel(selectedEffort) : model?.defaultEffort ? t('models.defaultEffort', { effort: effortLabel(model.defaultEffort) }) : t('models.unspecified'), disabled: true });
    options($('effort-select'), effortOptions, selectedEffort);
    const disabled = !state.ready || !state.connected || !current || current.canAcceptDirectInput === false || loading || busy() || isQueueBusy();
    $('model-select').disabled = disabled || !catalog.length;
    $('effort-select').disabled = disabled || !model?.efforts.length;
    $('models-refresh').disabled = loading || busy() || !state.connected;
    $('models-refresh').hidden = !failure && !needsRefresh;
    $('model-select').title = t('models.modelHint'); $('effort-select').title = t('models.effortHint');
    const hint = busy() ? 'models.saving' : failure ? 'models.loadFailed' : isWorking(state) ? 'models.nextTurn' : null;
    $('models-status').dataset.state = hint || '';
    $('models-status').hidden = !hint;
    $('models-status').textContent = hint ? t(hint) : '';
    if (busy()) { $('send').disabled = true; $('steer').disabled = true; }
  }
  async function refresh() {
    const epoch = generation, version = ++request;
    loading = true; failure = null; needsRefresh = false; render();
    try {
      const result = await api('/api/models');
      if (epoch !== generation || version !== request) return;
      catalog = result.models;
    } catch (error) {
      if (epoch === generation && version === request) { failure = error; catalog = []; }
    } finally { if (epoch === generation && version === request) { loading = false; render(); } }
  }
  function apply(id, value) {
    const state = getState(), thread = state.threads.find(thread => thread.id === id);
    const fields = { model: value.model, reasoningEffort: value.reasoningEffort };
    if (thread) Object.assign(thread, fields);
    if (state.thread?.id === id) Object.assign(state.thread, fields);
  }
  async function change(model, effort) {
    const state = getState(), id = state.selectedId, epoch = generation, version = events.get(id) || 0;
    if (!id || !state.ready || !state.connected || busy() || isQueueBusy()) { render(); return; }
    pending.set(id, { model, effort }); renderApp();
    try {
      const result = await api(endpoint(id), { model, ...(effort !== undefined ? { effort } : {}) });
      if (epoch !== generation) return;
      // A newer settings event (including another client's change) wins over a late acknowledgement.
      if ((events.get(id) || 0) === version) apply(id, result);
    } catch (error) {
      if (epoch !== generation) return;
      if (error.errorKey === 'models.unavailable') needsRefresh = true;
      notice(t('models.saveFailed', { error: errorText(error) }));
      // The mutation may have succeeded even if its HTTP response was lost. Never replay it.
      const observed = events.get(id) || 0;
      try {
        const result = await api(endpoint(id));
        if (epoch === generation && (events.get(id) || 0) === observed) apply(id, result);
      } catch { /* Keep the last observed model and the visible failure notice. */ }
    } finally { if (epoch === generation) { pending.delete(id); renderApp(); } }
  }
  $('model-select').onchange = () => {
    const model = catalog.find(model => model.model === $('model-select').value);
    if (!model) return;
    const current = getState().thread?.reasoningEffort;
    const effort = model.efforts.some(option => option.effort === current) ? current : model.efforts.some(option => option.effort === model.defaultEffort) ? model.defaultEffort : model.efforts[0]?.effort;
    change(model.model, effort);
  };
  $('effort-select').onchange = () => change($('model-select').value, $('effort-select').value);
  $('models-refresh').onclick = refresh;
  return {
    render, refresh, busy,
    reset() { ++generation; ++request; catalog = []; loading = false; failure = null; needsRefresh = false; pending.clear(); events.clear(); render(); },
    event(message) {
      if (message.method === 'thread/settings/updated') { const id = message.params.threadId; events.set(id, (events.get(id) || 0) + 1); }
      if (message.method === 'account/updated') refresh();
    },
  };
}
