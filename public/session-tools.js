import { t, errorText } from './i18n.js';
import { commandOf, commands, skillMentions } from './input.js';
import { isWorking, applyEvent } from './state.js';

const $ = id => document.getElementById(id);
const node = (tag, text, className = '') => { const el = document.createElement(tag); el.textContent = text; el.className = className; return el; };

export function initSessionTools({ api, getState, notice, renderApp, getDraft, saveDraft }) {
  const input = $('message'), mirror = $('input-highlight'), dialog = $('tools-dialog');
  let id = null, generation = 0, discovery = 0, catalog = [], skillState = 'loading', busy = false, view = null, data = null, error = null, request = 0, refreshTimer;
  const endpoint = action => `/api/threads/${encodeURIComponent(id)}/${action}`;
  const skillsFor = text => [...new Set(skillMentions(text, catalog).map(match => match.name))];

  async function discover(force = false) {
    const version = ++discovery, current = generation;
    if (!id || !getState().connected) return;
    skillState = 'loading'; render();
    try {
      const result = await api(endpoint(`skills${force ? '?refresh=1' : ''}`));
      if (version !== discovery || current !== generation) return;
      catalog = result.skills; skillState = result.incomplete ? 'partial' : 'ready';
    } catch { if (version === discovery && current === generation) { catalog = []; skillState = 'unavailable'; } }
    if (version === discovery && current === generation) render();
  }
  function highlight() {
    const command = commandOf(input.value);
    const matches = command ? [{ ...command, kind: 'command' }] : skillMentions(input.value, catalog).map(match => ({ ...match, kind: 'skill' }));
    const fragment = document.createDocumentFragment(); let offset = 0;
    for (const match of matches) {
      fragment.append(document.createTextNode(input.value.slice(offset, match.start)));
      fragment.append(node('mark', input.value.slice(match.start, match.end), `input-${match.kind}`));
      offset = match.end;
    }
    fragment.append(document.createTextNode(input.value.slice(offset) + '\n'));
    mirror.replaceChildren(fragment);
    mirror.scrollTop = input.scrollTop; mirror.scrollLeft = input.scrollLeft;
    mirror.style.width = `${input.clientWidth}px`;
    mirror.style.height = `${input.clientHeight}px`;
    $('input-skill-summary').textContent = command ? t(`tools.command.${command.name}`) : matches.length ? t('tools.selectedSkills', { names: [...new Set(matches.map(match => match.name))].join(', ') }) : '';
    $('input-skill-summary').hidden = !$('input-skill-summary').textContent;
  }
  function suggestions() {
    const list = $('input-suggestions');
    const before = input.value.slice(0, input.selectionStart);
    const match = before.match(/(^|[\s(])([/$])([a-zA-Z0-9_.:-]*)$/);
    list.replaceChildren();
    if (!match || document.activeElement !== input || input.selectionStart !== input.selectionEnd) { list.hidden = true; return; }
    const start = before.length - match[3].length - 1;
    const first = !input.value.slice(0, start).trim();
    // Reuse the same literal/code/path rules as highlighting and submission.
    const probe = input.value.slice(0, start) + '$probe' + input.value.slice(input.selectionStart);
    if (!skillMentions(probe, [{ name: 'probe' }]).some(part => part.start === start)) { list.hidden = true; return; }
    const options = [];
    const counts = new Map();
    for (const skill of catalog) counts.set(skill.name, (counts.get(skill.name) || 0) + 1);
    if (match[2] === '/' && first) for (const name of commands) options.push({ name, label: `/${name}`, description: t(`tools.command.${name}`) });
    if (!commandOf(input.value)) for (const skill of catalog) {
      if (counts.get(skill.name) !== 1 || match[2] === '/' && [...commands, 'model'].includes(skill.name)) continue;
      options.push({ name: skill.name, label: `${match[2]}${skill.name}`, description: skill.description });
    }
    for (const option of options.filter(option => option.name.startsWith(match[3]) && option.name !== match[3]).slice(0, 6)) {
      const button = node('button', option.label); button.type = 'button'; button.title = option.description;
      button.append(node('span', option.description));
      button.onmousedown = event => event.preventDefault();
      button.onclick = () => {
        input.setRangeText(option.label + ' ', start, input.selectionStart, 'end'); input.focus();
        input.dispatchEvent(new Event('input', { bubbles: true }));
      };
      list.append(button);
    }
    list.hidden = !list.childNodes.length;
  }
  function render() {
    highlight(); suggestions();
    $('session-tools').disabled = !getState().ready || !getState().connected;
    if (commandOf(input.value)) {
      $('send').disabled = busy || !getState().connected || !getState().ready;
      $('send').setAttribute('aria-label', t('tools.run')); $('send').title = t('tools.run');
      $('steer').hidden = true;
    } else if (busy) { $('send').disabled = true; $('steer').disabled = true; }
    if (dialog.open) renderDialog();
  }
  function show(next) {
    view = next; data = null; error = null; ++request;
    renderDialog(); if (!dialog.open) dialog.showModal();
  }
  function row(list, key, value) {
    list.append(node('dt', t(key)), node('dd', value == null ? t('tools.unknown') : String(value)));
  }
  const format = value => value == null ? null : new Intl.NumberFormat(document.documentElement.lang).format(value);
  function renderDialog() {
    $('tools-title').textContent = t(`tools.${view || 'help'}`);
    // Preserve an in-progress rename, including focus, when live events re-render the app.
    $('rename-form').hidden = view !== 'rename';
    $('rename-submit').disabled = busy;
    const content = $('tools-content'); content.replaceChildren();
    if (view === 'status') {
      if (error) content.append(node('p', errorText(error), 'error'));
      else if (!data) content.append(node('p', t('tools.loading')));
      else {
        const list = node('dl', '', 'session-facts');
        row(list, 'tools.session', data.thread.name || data.thread.id);
        row(list, 'tools.model', data.thread.model);
        row(list, 'tools.effort', data.thread.reasoningEffort);
        row(list, 'tools.folder', data.thread.cwd);
        row(list, 'tools.connection', getState().connected ? t('connection.connected') : t('connection.disconnected'));
        row(list, 'tools.activity', t(`status.${data.thread.status?.type}`, {}, data.thread.status?.type || t('tools.unknown')));
        const usage = data.usage;
        row(list, 'tools.totalTokens', format(usage?.total.totalTokens));
        row(list, 'tools.inputTokens', format(usage?.total.inputTokens));
        row(list, 'tools.cachedTokens', format(usage?.total.cachedInputTokens));
        row(list, 'tools.outputTokens', format(usage?.total.outputTokens));
        row(list, 'tools.reasoningTokens', format(usage?.total.reasoningOutputTokens));
        row(list, 'tools.lastTokens', format(usage?.last.totalTokens));
        row(list, 'tools.contextWindow', format(usage?.modelContextWindow));
        if (usage) row(list, 'tools.updated', new Date(usage.updatedAt).toLocaleString(document.documentElement.lang));
        content.append(list);
        content.append(node('p', t(!usage ? 'tools.awaitingUsage' : usage.stale || !getState().connected ? 'tools.staleUsage' : 'tools.reportedUsage'), 'tools-note'));
        content.append(node('p', t('tools.contextNote'), 'tools-note'));
        content.append(node('h3', t('tools.limits')));
        if (!data.limits?.length) content.append(node('p', t('tools.unknown')));
        for (const limit of data.limits || []) {
          const values = node('dl', '', 'session-facts'); content.append(node('h4', limit.name), values);
          for (const [index, window] of [limit.primary, limit.secondary].entries()) if (window) {
            row(values, index ? 'tools.secondaryLimit' : 'tools.primaryLimit', window.usedPercent == null ? null : `${format(window.usedPercent)}%`);
            if (window.windowDurationMins != null) row(values, 'tools.windowMinutes', format(window.windowDurationMins));
            row(values, 'tools.resets', window.resetsAt == null ? null : new Date(window.resetsAt * 1000).toLocaleString(document.documentElement.lang));
          }
        }
      }
    } else if (view === 'help') {
      for (const name of commands.filter(name => name !== 'help')) {
        const button = node('button', `/${name} — ${t(`tools.command.${name}`)}`, 'tool-action'); button.type = 'button';
        button.disabled = busy || !getState().connected || name === 'compact' && isWorking(getState());
        button.onclick = () => execute({ name, argument: '' }); content.append(button);
      }
      content.append(node('p', t('tools.skillsHelp'), 'tools-note'));
      content.append(node('p', skillState === 'ready' ? t('tools.skillCount', { count: catalog.length }) : t(`tools.skills.${skillState}`), 'tools-note'));
      const refresh = node('button', t('tools.refreshSkills'), 'tool-action'); refresh.type = 'button'; refresh.onclick = () => discover(true); content.append(refresh);
      for (const skill of catalog.slice(0, 100)) {
        const button = node('button', `$${skill.name}`, 'tool-action'); button.type = 'button'; button.title = skill.description;
        button.onclick = () => { dialog.close(); input.focus(); input.setRangeText(`$${skill.name} `, input.selectionStart, input.selectionEnd, 'end'); input.dispatchEvent(new Event('input', { bubbles: true })); };
        content.append(button);
      }
    }
    $('tools-error').textContent = view === 'rename' && error ? errorText(error) : '';
    $('tools-refresh').hidden = view !== 'status';
  }
  async function refreshStatus() {
    const version = ++request, current = generation;
    try { const result = await api(endpoint('status')); if (version === request && current === generation) { data = result; error = null; } }
    catch (failure) { if (version === request && current === generation) error = failure; }
    if (version === request && current === generation && dialog.open) renderDialog();
  }
  function clearCommand(text, threadId) {
    if (text == null) return;
    if (getDraft(threadId) === text) saveDraft(threadId, '');
    if (id === threadId && input.value === text) input.value = '';
  }
  async function execute(command, text) {
    if (busy || !id || !getState().ready || !getState().connected) return;
    if (command.name !== 'rename' && command.argument) { notice(t('tools.noArguments')); return; }
    if (command.name === 'rename' && !command.argument) {
      show('rename'); $('session-name').value = getState().thread?.name || ''; $('session-name').focus();
      clearCommand(text, id); renderApp(); return;
    }
    if (command.name === 'status' || command.name === 'help') {
      show(command.name); clearCommand(text, id); renderApp();
      if (command.name === 'status') await refreshStatus();
      return;
    }
    if (command.name === 'compact' && isWorking(getState())) { notice(t('tools.compactBusy')); return; }
    const current = generation, threadId = id;
    busy = true; error = null; renderApp();
    try {
      const result = await api(endpoint('command'), { command: command.name, ...(command.name === 'rename' ? { name: command.argument } : {}) });
      if (current !== generation) return;
      clearCommand(text, threadId);
      if (command.name === 'rename') applyEvent(getState(), { method: 'thread/name/updated', params: { threadId, threadName: result.name } });
      if (dialog.open) dialog.close();
      notice(t(command.name === 'rename' ? 'tools.renamed' : 'tools.compactStarted'));
    } catch (failure) { if (current === generation) { error = failure; if (view !== 'rename' || !dialog.open) notice(failure); } }
    finally { if (current === generation) { busy = false; renderApp(); } }
  }
  input.addEventListener('scroll', highlight);
  input.addEventListener('click', suggestions);
  input.addEventListener('keyup', event => { if (event.key !== 'Escape') suggestions(); });
  input.addEventListener('blur', () => { setTimeout(() => { if (!$('input-suggestions').contains(document.activeElement)) $('input-suggestions').hidden = true; }, 150); });
  new ResizeObserver(highlight).observe(input);
  $('session-tools').onclick = () => show('help');
  $('tools-close').onclick = () => dialog.close();
  $('tools-refresh').onclick = refreshStatus;
  $('rename-form').onsubmit = event => { event.preventDefault(); execute({ name: 'rename', argument: $('session-name').value }); };
  dialog.addEventListener('close', () => { ++request; clearTimeout(refreshTimer); });
  return {
    render, skillsFor, discover,
    reconnect() { discover(); if (dialog.open && view === 'status') refreshStatus(); },
    submit() { const command = commandOf(input.value); if (!command) return false; execute(command, input.value); return true; },
    selectThread(threadId) {
      if (threadId === id) return;
      ++generation; ++discovery; ++request; id = threadId; catalog = []; skillState = 'loading'; busy = false; data = null; error = null;
      clearTimeout(refreshTimer); if (dialog.open) dialog.close();
      render(); if (id) discover();
    },
    reset() { this.selectThread(null); mirror.replaceChildren(); $('input-suggestions').replaceChildren(); $('tools-content').replaceChildren(); $('session-name').value = ''; },
    event(message) {
      if (message.method === 'skills/changed') discover(true);
      if (dialog.open && view === 'status' && message.params?.threadId === id && ['thread/tokenUsage/updated', 'turn/completed', 'item/completed', 'thread/name/updated', 'thread/settings/updated'].includes(message.method)) {
        clearTimeout(refreshTimer); refreshTimer = setTimeout(refreshStatus, 600);
      }
    },
    keydown(event) {
      if (event.isComposing) return false;
      if (event.key === 'Escape') { $('input-suggestions').hidden = true; return false; }
      if (event.key === 'Tab' && !event.shiftKey && !$('input-suggestions').hidden) { event.preventDefault(); $('input-suggestions').querySelector('button')?.click(); return true; }
      return false;
    },
  };
}
