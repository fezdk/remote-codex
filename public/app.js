import { initProjects } from './projects.js';
import { initChanges } from './changes.js';
import { initQueue } from './queue.js';
import { initSessionTools } from './session-tools.js';
import { initGoals } from './goals.js';
import { initModels } from './models.js';
import { t, initPreferences, showError } from './i18n.js';
import { createState, mergeTurns, activeTurn, isWorking, applyEvent, restoreHistory, title, project, turnTiming, messageTiming } from './state.js';

const $ = id => document.getElementById(id);
const state = createState();
let events, streamWatchdog, nextCursor, turnsCursor, openVersion = 0, listVersion = 0, searchTimer, renderFrame;
let bufferedEvents = [], requestSignature = '', defaultCwd = '', draftId;
let historyRefresh, historyTimer;
const drafts = new Map();
const requestCards = new Map();
let authEpoch = 0;
const inFlight = new Set();
let connectionStatus = { state: 'connecting' };
const sessionTitle = thread => title(thread, t(state.loading ? 'session.loading' : 'nav.new'));
const projectTitle = path => project(path, t('session.project'));
function ui(tag, className, key, values = {}) {
  const node = el(tag, className, t(key, values));
  node.dataset.i18n = key; node.dataset.i18nValues = JSON.stringify(values); return node;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function notice(message) { if (!$('login').hidden) return; showError($('notice-text'), message); $('notice').hidden = false; }
async function api(path, data) {
  const epoch = authEpoch, controller = new AbortController();
  inFlight.add(controller);
  const timeout = setTimeout(() => controller.abort(), 45000);
  try {
  const response = await fetch(path, { signal: controller.signal, method: data === undefined ? 'GET' : 'POST', headers: data === undefined ? {} : { 'Content-Type': 'application/json' }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
  const result = await response.json();
  if (epoch !== authEpoch) throw new Error(t('error.login'));
  if (!response.ok) {
    if (response.status === 401 && path !== '/api/login') showLogin();
    throw Object.assign(new Error(result.error || t('error.connection')), { errorKey: result.errorKey });
  }
  return result;
  } catch (error) {
    if (error.name === 'AbortError') throw Object.assign(new Error(t('error.timeout')), { errorKey: 'error.timeout' });
    throw error;
  } finally { clearTimeout(timeout); inFlight.delete(controller); }
}
function showLogin() {
  ++authEpoch;
  for (const controller of inFlight) controller.abort();
  events?.close(); events = null;
  clearTimeout(streamWatchdog);
  clearTimeout(historyTimer); historyRefresh = null;
  ++openVersion; ++listVersion;
  clearTimeout(searchTimer); cancelAnimationFrame(renderFrame); renderFrame = null;
  defaultCwd = ''; nextCursor = null; turnsCursor = null;
  Object.assign(state, createState()); drafts.clear(); requestCards.clear(); draftId = null; bufferedEvents = []; requestSignature = '';
  queue.reset(); changes.selectThread(null); projects.reset(); sessionTools.reset(); models.reset(); goals.reset();
  $('message').value = ''; $('messages').replaceChildren(); $('requests').replaceChildren(); $('session-list').replaceChildren();
  $('notice').hidden = true; $('notice-text').textContent = ''; $('session-view').hidden = true; $('welcome').hidden = false;
  $('search').value = ''; setSidebar(false);
  for (const id of ['project-name', 'session-title', 'session-path', 'model-label']) $(id).textContent = '';
  $('workspace').hidden = true; $('login').hidden = false;
}
function setConnection(status) {
  connectionStatus = status;
  state.connected = status.state === 'connected';
  if (!state.connected) { state.ready = false; ++openVersion; state.loading = false; bufferedEvents = []; state.requests.clear(); renderRequests(); }
  renderConnection();
  renderList();
  renderControls();
}
function renderConnection() {
  const status = connectionStatus;
  $('connection').className = `connection ${state.connected ? 'connected' : ''}`;
  $('connection-label').textContent = state.connected ? t('connection.connected') : t('connection.disconnected');
  $('machine-state').textContent = state.connected ? `${t('connection.online')}${status.platform ? ` · ${status.platform}` : ''}` : t('connection.waiting');
  $('connection-banner').hidden = state.connected;
  $('connection-banner').textContent = t('connection.banner', { reason: status.errorKey ? t(status.errorKey) : status.error || t('connection.retry') });
  renderControls();
}
async function enter() {
  const status = await api('/api/status');
  defaultCwd = status.defaultCwd;
  $('login').hidden = true; $('workspace').hidden = false;
  setConnection(status);
  connectEvents();
}
function connectEvents() {
  events?.close();
  events = new EventSource('/api/events');
  const stream = events;
  const keepAlive = () => {
    clearTimeout(streamWatchdog);
    streamWatchdog = setTimeout(() => {
      if (stream !== events) return;
      setConnection({ state: 'disconnected', errorKey: 'connection.browserLost' });
      connectEvents();
    }, 45000);
  };
  keepAlive();
  const listen = (type, handler) => stream.addEventListener(type, event => { if (stream === events) { keepAlive(); handler(event); } });
  listen('heartbeat', () => {});
  listen('status', event => {
    const wasConnected = state.connected;
    const status = JSON.parse(event.data);
    setConnection(status);
    if (status.state === 'connected' && !wasConnected) resync();
  });
  listen('pending', event => {
    state.requests = new Map(JSON.parse(event.data).map(r => [JSON.stringify(r.id), r]));
    renderRequests(); renderList();
  });
  listen('resync', () => resync());
  listen('codex', event => {
    const message = JSON.parse(event.data);
    if (state.loading) bufferedEvents.push(message);
    if (historyRefresh) historyRefresh.events.push(message);
    applyEvent(state, message); changes.event(message); queue.event(message); sessionTools.event(message); models.event(message); goals.event(message);
    if (message.params?.threadId === state.selectedId && ['turn/started', 'turn/completed'].includes(message.method)) scheduleHistoryRefresh();
    if (message.method === 'bridge/subscriptionError' && message.params.threadId === state.selectedId) notice(message.params.message);
    scheduleRender();
  });
  events.onerror = () => {
    if (stream !== events) return;
    setConnection({ state: 'disconnected', errorKey: 'connection.browserLost' });
    api('/api/status').catch(error => { if (!$('login').hidden) showError($('login-error'), error); });
  };
}
async function resync() {
  if (!state.connected) return;
  const epoch = authEpoch;
  await loadThreads().catch(error => notice(error));
  if (epoch !== authEpoch) return;
  const target = state.selectedId || new URLSearchParams(location.hash.slice(1)).get('session');
  if (target) await openThread(target, true);
  sessionTools.reconnect();
  models.refresh();
}
function ago(timestamp) {
  const minutes = Math.max(0, Math.floor((Date.now()/1000 - timestamp)/60));
  if (minutes < 1) return t('time.now');
  if (minutes < 60) return t('time.minutes', { count: minutes });
  if (minutes < 1440) return t('time.hours', { count: Math.floor(minutes/60) });
  return t('time.days', { count: Math.floor(minutes/1440) });
}
async function loadThreads(more = false) {
  const version = ++listVersion;
  const params = new URLSearchParams();
  if ($('search').value) params.set('search', $('search').value);
  if (more && nextCursor) params.set('cursor', nextCursor);
  const response = await api(`/api/threads?${params}`);
  if (version !== listVersion) return;
  state.threads = more ? [...new Map([...state.threads, ...response.data].map(t => [t.id,t])).values()] : response.data;
  nextCursor = response.nextCursor;
  $('more-sessions').hidden = !nextCursor;
  renderList();
}
function renderList() {
  const fragment = document.createDocumentFragment();
  if (!state.threads.length) fragment.append(el('div','empty-list', $('search').value ? t('list.noMatch') : t('list.empty')));
  let lastGroup;
  for (const thread of state.threads) {
    const group = Date.now()/1000 - thread.updatedAt < 86400 ? t('list.recent') : t('list.earlier');
    if (lastGroup !== group) { fragment.append(el('div','session-group',group)); lastGroup = group; }
    const button = el('button', `session-row${state.selectedId === thread.id ? ' selected' : ''}`);
    button.setAttribute('aria-current', state.selectedId === thread.id ? 'true' : 'false');
    button.title = `${sessionTitle(thread)}\n${thread.cwd}`;
    const selected = state.selectedId === thread.id;
    const status = selected && state.thread?.id === thread.id ? state.thread.status : thread.status;
    const waiting = status?.type === 'active' && status.activeFlags?.some(flag => ['waitingOnApproval', 'waitingOnUserInput'].includes(flag))
      || [...state.requests.values()].some(request => request.params?.threadId === thread.id);
    const working = status?.type === 'active' || selected && isWorking(state);
    const activity = waiting || working ? !state.connected ? 'unknown' : waiting ? 'waiting' : 'working' : null;
    const heading = el('div', 'session-row-heading');
    heading.append(el('div', 'session-row-title', sessionTitle(thread)));
    if (activity) {
      button.dataset.activity = activity;
      const badge = el('span', 'session-activity'); badge.title = t(`list.${activity}Hint`);
      const dot = el('span', 'session-activity-dot'); dot.setAttribute('aria-hidden', 'true');
      badge.append(dot, document.createTextNode(t(`list.${activity}`))); heading.append(badge);
      button.title += `\n${badge.title}`;
    }
    button.append(heading);
    const meta = el('div','session-row-meta');
    const dot = el('span', 'status-dot'); dot.setAttribute('aria-hidden', 'true');
    meta.append(dot, el('span','path-short',projectTitle(thread.cwd)),el('time','',ago(thread.updatedAt)));
    button.append(meta); button.onclick = () => openThread(thread.id);
    fragment.append(button);
  }
  $('session-list').replaceChildren(fragment);
}
async function openThread(id, resyncing = false) {
  if (!state.connected) return notice(t('connection.wait'));
  if (draftId) drafts.set(draftId, $('message').value);
  draftId = id;
  $('message').value = drafts.get(id) || '';
  const version = ++openVersion;
  clearTimeout(historyTimer); historyRefresh = null;
  state.selectedId = id; state.loading = true; state.ready = false; bufferedEvents = [];
  history.replaceState(null, '', `#session=${encodeURIComponent(id)}`);
  if (!resyncing || state.thread?.id !== id) { state.turns = []; state.thread = state.threads.find(t => t.id === id) || { id }; }
  $('welcome').hidden = true; $('session-view').hidden = false;
  changes.selectThread(id); queue.selectThread(id); sessionTools.selectThread(id); goals.selectThread(id);
  setSidebar(false); renderAll();
  try {
    const response = await api(`/api/threads/${encodeURIComponent(id)}/open`, {});
    if (version !== openVersion) return;
    state.thread = response.thread;
    state.thread.model ||= response.model;
    state.thread.reasoningEffort ??= response.reasoningEffort;
    const page = await api(`/api/threads/${encodeURIComponent(id)}/turns`);
    if (version !== openVersion) return;
    restoreHistory(state, [...page.data].reverse(), bufferedEvents, page.bridgeSequence);
    turnsCursor = page.nextCursor;
    bufferedEvents = [];
    state.ready = true; changes.refresh(); queue.refresh(); goals.refresh();
  } catch (error) {
    if (version === openVersion) notice(error);
  } finally {
    if (version === openVersion) { state.loading = false; renderAll(!resyncing); }
  }
}

// Heal missed item notifications from persisted history without reopening the
// session, clearing a draft, changing pagination, or replaying a submission.
function scheduleHistoryRefresh() {
  clearTimeout(historyTimer);
  historyTimer = setTimeout(refreshRecentHistory, 250);
}
async function refreshRecentHistory() {
  if (!state.ready || state.loading || !state.connected || !state.selectedId) return;
  if (historyRefresh) { historyRefresh.again = true; return; }
  const refresh = historyRefresh = { version: openVersion, id: state.selectedId, events: [] };
  try {
    const page = await api(`/api/threads/${encodeURIComponent(refresh.id)}/turns`);
    if (historyRefresh !== refresh || refresh.version !== openVersion) return;
    restoreHistory(state, mergeTurns(state.turns, [...page.data].reverse()), refresh.events, page.bridgeSequence);
    renderMessages(); renderControls();
  } catch (error) {
    if (historyRefresh === refresh && refresh.version === openVersion) notice(error);
  } finally {
    if (historyRefresh === refresh) { historyRefresh = null; if (refresh.again) scheduleHistoryRefresh(); }
  }
}
function setSidebar(open) {
  $('sidebar').classList.toggle('open', open);
  $('sidebar-shade').hidden = !open;
  $('toggle-sidebar').setAttribute('aria-expanded', String(open));
}
function renderHeader() {
  if (!state.thread) { $('project-name').textContent = t('nav.overview'); return; }
  $('project-name').textContent = projectTitle(state.thread.cwd);
  $('session-title').textContent = sessionTitle(state.thread);
  $('session-path').textContent = state.thread.cwd || '';
  $('model-label').textContent = [state.thread.model || 'Codex', state.thread.reasoningEffort].filter(Boolean).join(' · ');
  const active = isWorking(state);
  const waiting = [...state.requests.values()].some(r => r.params?.threadId === state.selectedId);
  $('session-status').textContent = state.loading ? t('status.loading') : waiting ? t('status.waiting') : active ? t('status.working') : t('status.ready');
  $('session-status').className = `session-status ${active ? 'active' : ''}`;
}

// Build text and a small Markdown subset with DOM nodes. No model output is inserted as HTML.
function inline(node, text) {
  const pattern = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\[[^\[\]\n]+\]\(https?:\/\/[^\s()]+\))/g;
  let start = 0;
  for (const match of text.matchAll(pattern)) {
    node.append(document.createTextNode(text.slice(start,match.index)));
    const value = match[0];
    if (value.startsWith('`')) node.append(el('code','',value.slice(1,-1)));
    else if (value.startsWith('**')) node.append(el('strong','',value.slice(2,-2)));
    else {
      const parts = value.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      const a = el('a','',parts[1]); a.href = parts[2]; a.target = '_blank'; a.rel = 'noopener noreferrer'; node.append(a);
    }
    start = match.index + value.length;
  }
  node.append(document.createTextNode(text.slice(start)));
}
function tableRow(line) {
  const cells = []; let value = '', code = 0, pipes = 0;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '\\' && ['|', '\\', '`'].includes(line[i + 1])) {
      value += line[i + 1] === '|' ? '|' : char + line[i + 1]; i++; continue;
    }
    if (char === '`') {
      let end = i + 1; while (line[end] === '`') end++;
      const count = end - i;
      if (!code) code = count; else if (code === count) code = 0;
      value += line.slice(i, end); i = end - 1; continue;
    }
    if (char === '|' && !code) { cells.push(value.trim()); value = ''; pipes++; }
    else value += char;
  }
  cells.push(value.trim());
  if (pipes && cells[0] === '') cells.shift();
  if (pipes && cells.at(-1) === '') cells.pop();
  return { cells, pipes };
}
function markdownTables(node, text, budget) {
  const lines = text.split('\n'), pending = [];
  const flush = () => { if (pending.length) { inline(node, pending.join('')); pending.length = 0; } };
  for (let i = 0; i < lines.length;) {
    const header = tableRow(lines[i]), separator = i + 1 < lines.length ? tableRow(lines[i + 1]) : null;
    const count = header.cells.length;
    if (!header.pipes || !count || count > 100 || count > budget.cells || separator?.cells.length !== count || !separator.cells.every(cell => /^:?-+:?$/.test(cell))) {
      pending.push(lines[i] + (i + 1 < lines.length ? '\n' : '')); i++; continue;
    }
    flush();
    const wrapper = el('div', 'markdown-table'), table = el('table'), head = el('thead'), body = el('tbody');
    wrapper.tabIndex = 0; wrapper.setAttribute('role', 'region'); wrapper.setAttribute('aria-label', t('session.table'));
    const alignments = separator.cells.map(cell => cell.endsWith(':') ? cell.startsWith(':') ? 'center' : 'right' : 'left');
    const row = (values, heading = false) => {
      const tr = el('tr');
      for (let col = 0; col < count; col++) {
        const cell = el(heading ? 'th' : 'td', `align-${alignments[col]}`);
        if (heading) cell.scope = 'col';
        inline(cell, values[col] || ''); tr.append(cell);
      }
      budget.cells -= count; return tr;
    };
    head.append(row(header.cells, true)); i += 2;
    while (i < lines.length && lines[i].trim() && budget.cells >= count) {
      const next = tableRow(lines[i]);
      if (!next.pipes) break;
      body.append(row(next.cells)); i++;
    }
    table.append(head, body); wrapper.append(table); node.append(wrapper);
  }
  flush();
}
function markdown(text) {
  const node = el('div','message-body');
  const budget = { cells: 5000 };
  const parts = displayText(text).split(/```[^\n`]*\n([\s\S]*?)(?:```|$)/g);
  parts.forEach((part,index) => { if (index % 2) { const pre = el('pre'); pre.append(el('code','',part)); node.append(pre); } else markdownTables(node,part,budget); });
  return node;
}
function displayText(text) {
  const value = String(text);
  return value.length > 200000 ? `${value.slice(0, 200000)}\n\n${t('session.truncated')}` : value;
}
function formatDuration(milliseconds) {
  const seconds = Math.floor(milliseconds / 1000), minutes = Math.floor(seconds / 60), hours = Math.floor(minutes / 60);
  return hours ? t('timing.hours', { hours, minutes: minutes % 60, seconds: seconds % 60 }) : minutes ? t('timing.minutes', { minutes, seconds: seconds % 60 }) : t('timing.seconds', { seconds });
}
const timeFormatters = new Map();
function timeLabel(at, source) {
  const date = new Date(at), locale = document.documentElement.lang === 'da' ? 'da-DK' : 'en-GB';
  if (!timeFormatters.has(locale)) timeFormatters.set(locale, [new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }), new Intl.DateTimeFormat(locale, { dateStyle: 'long', timeStyle: 'long' })]);
  const [clockFormat, fullFormat] = timeFormatters.get(locale);
  const clock = clockFormat.format(date), full = fullFormat.format(date);
  const node = el('time', 'message-time', t(`timing.${source}`, { time: clock }));
  node.dateTime = date.toISOString();
  node.title = `${full} · ${t(`timing.${source}Hint`)}`;
  node.setAttribute('aria-label', node.title);
  return node;
}
function renderTurnTiming(turn) {
  const timing = turnTiming(turn), row = el('div', 'turn-timing'); row.dataset.turnId = turn.id;
  if (timing.start !== null) row.append(timeLabel(timing.start, 'start'));
  if (timing.end !== null) row.append(timeLabel(timing.end, 'end'));
  const duration = el('span', 'turn-duration');
  duration.title = t(timing.active ? 'timing.elapsedHint' : 'timing.durationHint');
  row.append(duration);
  if (timing.active) row.dataset.active = 'true';
  updateTurnDuration(row, turn);
  return row;
}
function updateTurnDuration(row, turn) {
  const timing = turnTiming(turn);
  const label = timing.active ? 'timing.elapsed' : turn.status === 'interrupted' ? 'timing.interrupted' : turn.status === 'failed' ? 'timing.failed' : 'timing.duration';
  row.querySelector('.turn-duration').textContent = timing.active && !state.connected ? t('timing.disconnected') : timing.duration === null ? t('timing.unknownDuration') : t(label, { duration: formatDuration(timing.duration) });
}
function renderItem(item, turn) {
  if (item.type === 'userMessage' || item.type === 'agentMessage') {
    const user = item.type === 'userMessage';
    const wrapper = el('article',`message ${user ? 'user' : 'agent'}`);
    wrapper.dataset.itemId = item.id;
    const label = el('div','message-label');
    label.append(el('span','avatar',user ? t('session.you').slice(0, 1) : '⌘'),document.createTextNode(user ? t('session.you') : 'Codex'));
    const timing = turn ? messageTiming(state, turn, item) : item.submittedAt != null ? { at: item.submittedAt, source: 'sent' } : null;
    if (timing) label.append(timeLabel(timing.at, timing.source));
    else { const unknown = el('span', 'message-time unknown', '—'); unknown.title = t('timing.unknownMessage'); unknown.setAttribute('aria-label', unknown.title); label.append(unknown); }
    wrapper.append(label);
    const text = user ? (item.content || []).filter(c => c.type !== 'skill').map(c => c.text || (c.type === 'image' || c.type === 'localImage' ? t('session.image') : `[${c.type}]`)).join('\n') : item.text || '';
    const questionText = (item.questions || []).map(q => q.title).join('\n');
    // Async questions may repeat their titles verbatim in the agent's text.
    // Keep the question cards once, preserving any separate surrounding prose.
    if (user || !questionText || text.trim() !== questionText.trim()) wrapper.append(user ? el('div','message-body',displayText(text)) : markdown(text));
    const skills = user && (item.content || []).filter(c => c.type === 'skill').map(c => c.name);
    if (skills?.length) wrapper.append(el('div', 'delivery-status', t('tools.selectedSkills', { names: skills.join(', ') })));
    for (const q of item.questions || []) {
      const card = el('div','request-card'); card.append(el('p','',q.title));
      const actions = el('div','request-actions');
      for (const option of q.options || []) { const b = el('button','',option); b.onclick = () => queue.restoreDraft(option); actions.append(b); }
      card.append(actions); wrapper.append(card);
    }
    return wrapper;
  }
  const labels = { imageView:t('tool.image'), imageGeneration:t('tool.imageGeneration'), sleep:t('tool.sleep'), hookPrompt:t('tool.hook'), enteredReviewMode:t('tool.enterReview'), exitedReviewMode:t('tool.exitReview'), reasoning:t('tool.reasoning'), plan:t('tool.plan'), commandExecution: item.command || t('tool.command'), fileChange:t('tool.files'), mcpToolCall: `${item.server} / ${item.tool}`, dynamicToolCall:item.tool, collabAgentToolCall:t('tool.agent', { name: item.tool }), contextCompaction:t('tool.compaction'), functionCallOutput: item.name || t('tool.output'), webSearch:t('tool.web'), subAgentActivity:t('tool.agent', { name: item.agentPath }) };
  const details = el('details','tool-item'); details.dataset.itemId = item.id;
  const summary = el('summary'); summary.append(document.createTextNode(labels[item.type] || item.type));
  if (item.status) summary.append(el('span','tool-status',t(`status.${item.status}`, {}, item.status)));
  details.append(summary);
  let text;
  if (item.type === 'reasoning') text = (item.summary || []).join('\n');
  else if (item.type === 'commandExecution') text = [item.cwd, item.aggregatedOutput, item.exitCode != null ? t('tool.exit', { code: item.exitCode }) : null].filter(v=>v != null).join('\n');
  else if (item.type === 'fileChange') text = (item.changes || []).map(c => `${c.path}\n${c.diff || ''}`).join('\n\n');
  else text = item.text || JSON.stringify(item,null,2);
  details.append(el('pre','',displayText(text || t('tool.waiting'))));
  return details;
}
function renderMessages(forceBottom = false) {
  const timeline = $('timeline');
  const bottom = forceBottom || timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight < 100;
  const scrollTop = timeline.scrollTop;
  const expanded = new Set([...$('messages').querySelectorAll('details[open]')].map(d=>d.dataset.itemId));
  const fragment = document.createDocumentFragment();
  if (!state.turns.length) fragment.append(el('div','empty-list',state.loading ? t('session.loadingHistory') : t('session.empty')));
  for (const turn of state.turns) {
    for (const item of turn.items || []) {
      const node = renderItem(item, turn);
      if (expanded.has(item.id) && node.tagName === 'DETAILS') node.open = true;
      fragment.append(node);
    }
    if (turn.error) fragment.append(el('div','turn-error', turn.error.message || t('error.codex')));
    if (turn.status === 'interrupted') fragment.append(el('div','turn-marker',t('status.interrupted')));
    fragment.append(renderTurnTiming(turn));
  }
  for (const item of queue.messages()) {
    const message = renderItem({ id: `local-steer-${item.id}`, type: 'userMessage', content: item.input, submittedAt: item.submittedAt });
    message.classList.add('pending-steer');
    message.dataset.deliveryState = item.confirmed ? 'accepted' : 'sending';
    const status = el('div', 'delivery-status', t(item.confirmed ? 'queue.steerAccepted' : 'queue.steerSending'));
    status.setAttribute('role', 'status');
    message.append(status); fragment.append(message);
  }
  $('messages').replaceChildren(fragment);
  $('older-turns').hidden = !turnsCursor || state.loading;
  $('activity').hidden = !state.connected || !isWorking(state);
  timeline.scrollTop = bottom ? timeline.scrollHeight : scrollTop;
}
const mobileComposer = window.matchMedia('(max-width: 760px)');
let composerSize = {};
function resizeComposer() {
  const input = $('message'), width = input.clientWidth;
  if (!width) return;
  const mobile = mobileComposer.matches;
  const viewport = window.visualViewport?.height || window.innerHeight;
  const maximum = mobile ? Math.max(64, Math.min(144, Math.floor(viewport * .28))) : 180;
  if (composerSize.text === input.value && composerSize.width === width && composerSize.maximum === maximum && composerSize.mobile === mobile) return;
  const timeline = $('timeline');
  const pinned = timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight < 100;
  const scroll = input.scrollTop;
  input.style.height = '0px';
  input.style.height = `${Math.min(maximum, Math.max(mobile ? 42 : 66, input.value ? input.scrollHeight : 0))}px`;
  input.style.overflowY = input.value && input.scrollHeight > input.clientHeight ? 'auto' : 'hidden';
  input.scrollTop = scroll;
  if (pinned) timeline.scrollTop = timeline.scrollHeight;
  composerSize = { text: input.value, width, maximum, mobile };
}
function updateComposerViewport() {
  const timeline = $('timeline');
  const pinned = timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight < 100;
  const viewport = window.visualViewport;
  if (!viewport || viewport.scale === 1) document.documentElement.style.setProperty('--mobile-height', `${Math.round(viewport?.height || innerHeight)}px`);
  resizeComposer();
  if (pinned) timeline.scrollTop = timeline.scrollHeight;
}
function renderControls() {
  const active = activeTurn(state);
  const working = isWorking(state);
  const waiting = [...state.requests.values()].some(request => request.params?.threadId === state.selectedId);
  $('composer-status').hidden = !state.connected || state.loading || !working;
  $('composer-status').classList.toggle('waiting', waiting);
  $('composer-status-label').textContent = t(waiting ? 'status.waiting' : 'session.processing');
  const unavailable = state.thread?.canAcceptDirectInput === false;
  const disabled = !state.connected || !state.ready || state.loading || unavailable;
  $('send').disabled = disabled || !$('message').value.trim();
  $('message').disabled = !state.selectedId || state.loading || unavailable;
  $('interrupt').hidden = !active;
  $('interrupt').disabled = disabled;
  $('new-session').disabled = !state.connected;
  $('welcome-new').disabled = !state.connected;
  $('input-warning').hidden = !unavailable;
  $('input-warning').textContent = t('session.noInput');
  $('send-mode').textContent = active ? t('session.steer') : t('session.defaults');
  queue.render();
  if (mobileComposer.matches && working) $('message').placeholder = t('composer.nextMessage');
  resizeComposer();
  sessionTools.render();
  models.render(); goals.render();
}
function renderRequests() {
  const pendingTokens = new Set([...state.requests.values()].map(request => request.requestToken));
  for (const token of requestCards.keys()) if (!pendingTokens.has(token)) requestCards.delete(token);
  const requests = [...state.requests.values()].filter(r => r.params?.threadId === state.selectedId);
  const signature = JSON.stringify(requests);
  if (signature === requestSignature) return;
  requestSignature = signature;
  const focused = $('requests').contains(document.activeElement) ? document.activeElement : null;
  const fragment = document.createDocumentFragment();
  for (const request of requests) {
    const previous = requestCards.get(request.requestToken);
    if (previous && previous.dataset.signature === JSON.stringify(request)) { fragment.append(previous); continue; }
    const card = el('form','request-card');
    card.dataset.requestToken = request.requestToken; card.dataset.signature = JSON.stringify(request);
    requestCards.set(request.requestToken, card);
    const isQuestions = request.method === 'item/tool/requestUserInput';
    const supported = ['item/commandExecution/requestApproval','item/fileChange/requestApproval'].includes(request.method);
    card.append(ui('h3','',isQuestions ? 'request.questions' : supported ? 'request.approval' : 'request.originalTitle'));
    if (request.params.reason) card.append(el('p','',request.params.reason));
    if (supported) {
      if (request.params.command) card.append(el('pre','',request.params.command));
      if (request.params.cwd) card.append(el('p','',request.params.cwd));
      if (request.params.grantRoot) card.append(ui('p','','request.access',{path:request.params.grantRoot}));
      if (request.params.additionalPermissions || request.params.networkApprovalContext) card.append(el('pre','',JSON.stringify(request.params.additionalPermissions || request.params.networkApprovalContext,null,2)));
      const changedItem = state.turns.flatMap(t => t.items).find(i => i.id === request.params.itemId);
      if (changedItem?.changes) card.append(el('pre','',changedItem.changes.map(c=>`${c.path}\n${c.diff || ''}`).join('\n\n')));
    }
    const errorNode = el('p','error'); errorNode.setAttribute('role','alert');
    const answers = new Map();
    if (isQuestions) for (const q of request.params.questions) {
      const label = el('label','',q.question);
      const input = el('input'); input.type = q.isSecret ? 'password' : 'text'; input.required = true; input.autocomplete = 'off'; input.dataset.i18nPlaceholder = 'request.placeholder'; input.placeholder = t('request.placeholder');
      label.append(input); card.append(label); answers.set(q.id,input);
      if (q.options?.length) {
        const select = el('select'); select.setAttribute('aria-label',q.header || q.question);
        const empty = ui('option','','request.suggestion'); empty.value=''; select.append(empty);
        for (const option of q.options) { const opt=el('option','',`${option.label}${option.description ? ` — ${option.description}` : ''}`);opt.value=option.label;select.append(opt); }
        select.onchange = () => { input.value = select.value; };
        card.append(select);
      }
    }
    const actions = el('div','request-actions');
    const respond = async payload => {
      for (const b of card.querySelectorAll('button')) b.disabled=true;
      try { await api('/api/respond',{ id: request.id, requestToken: request.requestToken, ...payload }); if (state.requests.get(JSON.stringify(request.id))?.requestToken === request.requestToken) state.requests.delete(JSON.stringify(request.id)); renderRequests(); }
      catch (error) { showError(errorNode, error);for (const b of card.querySelectorAll('button')) b.disabled=false; }
    };
    if (supported) {
      const offered = request.params.availableDecisions || ['accept','decline','cancel'];
      for (const [decision,label] of [['decline','request.decline'],['cancel','request.cancel'],['accept','request.accept']]) {
        if (!offered.includes(decision)) continue;
        const button=ui('button',decision === 'accept' ? 'approve' : '',label);button.type='button';button.onclick=()=>respond({decision});actions.append(button);
      }
      if (!actions.childNodes.length) card.append(ui('p','','request.original'));
    } else if (isQuestions) {
      const button=ui('button','approve','request.send');button.type='submit';actions.append(button);
      card.onsubmit=event=>{event.preventDefault();respond({answers:Object.fromEntries([...answers].map(([id,input])=>[id,input.value]))});};
    } else {
      card.append(ui('p','','request.unsupported',{method:request.method}));
      card.onsubmit=event=>event.preventDefault();
    }
    card.append(errorNode,actions);fragment.append(card);
  }
  $('requests').replaceChildren(fragment);
  if (focused?.isConnected) focused.focus({ preventScroll: true });
}
function renderAll(forceBottom = false) { renderList(); renderHeader(); renderMessages(forceBottom); renderRequests(); renderControls(); }
function scheduleRender() {
  if (renderFrame) return;
  renderFrame = requestAnimationFrame(()=>{renderFrame = null;renderAll();});
}

$('login-form').onsubmit = async event => {
  event.preventDefault(); const button=event.submitter;button.disabled=true;$('login-error').textContent='';
  try { await api('/api/login',{token:$('access-key').value.trim()});$('access-key').value='';await enter(); }
  catch(error) { showError($('login-error'), error); }
  finally {button.disabled=false;}
};
$('logout').onclick = async () => {
  try { await api('/api/logout',{}); history.replaceState(null,'',location.pathname);showLogin(); }
  catch(error) {notice(error);}
};
$('dismiss-notice').onclick=()=>{$('notice').hidden=true;};
$('toggle-sidebar').onclick=()=>setSidebar(!$('sidebar').classList.contains('open'));
$('sidebar-shade').onclick=()=>setSidebar(false);
$('search').oninput=()=>{clearTimeout(searchTimer);searchTimer=setTimeout(()=>loadThreads().catch(e=>notice(e)),250);};
$('refresh').onclick=()=>loadThreads().catch(e=>notice(e));
$('more-sessions').onclick=()=>loadThreads(true).catch(e=>notice(e));
$('older-turns').onclick=async()=>{
  const version=openVersion,id=state.selectedId,cursor=turnsCursor,button=$('older-turns');button.disabled=true;
  const oldHeight=$('timeline').scrollHeight,oldTop=$('timeline').scrollTop;
  try { const page=await api(`/api/threads/${encodeURIComponent(id)}/turns?cursor=${encodeURIComponent(cursor)}`);if(version!==openVersion)return;state.turns=mergeTurns(page.data,state.turns);turnsCursor=page.nextCursor;renderMessages();$('timeline').scrollTop=oldTop+$('timeline').scrollHeight-oldHeight; }
  catch(error){notice(error);}finally{button.disabled=false;}
};
$('new-session').onclick = () => projects.open();
$('welcome-new').onclick = () => projects.open();
$('message').oninput=()=>{drafts.set(state.selectedId,$('message').value);renderControls();};
$('message').onkeydown=event=>{if(sessionTools.keydown(event))return;queue.keydown(event);if(event.key==='Enter'&&!event.shiftKey&&!event.isComposing){event.preventDefault();if(!$('send').disabled)$('composer').requestSubmit();}};
$('composer-options-toggle').onclick = () => {
  const open = $('composer').classList.toggle('options-open');
  $('composer-options-toggle').setAttribute('aria-expanded', String(open));
};
$('composer').onsubmit=event=>{event.preventDefault();queue.submit();};
$('interrupt').onclick=async()=>{const turn=activeTurn(state);if(!turn)return;try{await api(`/api/threads/${encodeURIComponent(state.selectedId)}/interrupt`,{turnId:turn.id});}catch(error){notice(error);}};
window.addEventListener('hashchange',()=>{const id=new URLSearchParams(location.hash.slice(1)).get('session');if(id&&id!==state.selectedId)openThread(id);});
document.addEventListener('visibilitychange', () => { if (!document.hidden) scheduleHistoryRefresh(); });
setInterval(() => {
  if (document.hidden || state.loading) return;
  for (const row of $('messages').querySelectorAll('.turn-timing[data-active]')) {
    const turn = state.turns.find(turn => turn.id === row.dataset.turnId);
    if (turn) updateTurnDuration(row, turn);
  }
}, 1000);
setInterval(()=>{if(state.connected&&!document.hidden&&!state.loading)loadThreads().catch(()=>{});},30000);
const changes = initChanges({ api, getState: () => state });
const sessionTools = initSessionTools({ openGoal: () => goals.open(), api, getState: () => state, notice, renderApp: renderAll, getDraft: id => drafts.get(id) || '', saveDraft: (id, text) => drafts.set(id, text) });
const goals = initGoals({ api, getState: () => state });
const models = initModels({ api, getState: () => state, renderApp: renderAll, notice, isQueueBusy: () => queue.isBusy() });
const queue = initQueue({ api, getState: () => state, notice, renderApp: renderAll, getDraft: id => drafts.get(id) || '', saveDraft: (id, text) => drafts.set(id, text), skillsFor: sessionTools.skillsFor, handleCommand: sessionTools.submit, isSettingsBusy: models.busy, refreshHistory: scheduleHistoryRefresh });
const projects = initProjects({ api, getDefaultCwd: () => state.thread?.cwd || defaultCwd, onCreated: async result => { await loadThreads().catch(notice); await openThread(result.thread.id); } });
initPreferences(() => { renderConnection(); renderAll(); changes.render(); projects.render(); });
new ResizeObserver(resizeComposer).observe($('message'));
window.addEventListener('resize', updateComposerViewport);
window.visualViewport?.addEventListener('resize', updateComposerViewport);
updateComposerViewport();
enter().catch(()=>showLogin());
