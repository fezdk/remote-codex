import { initProjects } from './projects.js';
import { initChanges } from './changes.js';
import { initQueue } from './queue.js';
import { t, initPreferences, showError } from './i18n.js';
import { createState, mergeTurns, activeTurn, isWorking, applyEvent, title, project } from './state.js';

const $ = id => document.getElementById(id);
const state = createState();
let events, nextCursor, turnsCursor, openVersion = 0, listVersion = 0, searchTimer, renderFrame;
let bufferedEvents = [], requestSignature = '', defaultCwd = '', draftId;
const drafts = new Map();
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
function notice(message) { showError($('notice-text'), message); $('notice').hidden = false; }
async function api(path, data) {
  const response = await fetch(path, { method: data === undefined ? 'GET' : 'POST', headers: data === undefined ? {} : { 'Content-Type': 'application/json' }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
  const result = await response.json();
  if (!response.ok) {
    if (response.status === 401 && path !== '/api/login') showLogin();
    throw Object.assign(new Error(result.error || t('error.connection')), { errorKey: result.errorKey });
  }
  return result;
}
function showLogin() {
  events?.close(); events = null;
  state.connected = false;
  ++openVersion; ++listVersion;
  $('workspace').hidden = true; $('login').hidden = false;
}
function setConnection(status) {
  connectionStatus = status;
  state.connected = status.state === 'connected';
  if (!state.connected) { state.requests.clear(); renderRequests(); }
  renderConnection();
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
  events?.close();
  events = new EventSource('/api/events');
  events.addEventListener('status', event => {
    const wasConnected = state.connected;
    const status = JSON.parse(event.data);
    setConnection(status);
    if (status.state === 'connected' && !wasConnected) resync();
  });
  events.addEventListener('pending', event => {
    state.requests = new Map(JSON.parse(event.data).map(r => [JSON.stringify(r.id), r]));
    renderRequests();
  });
  events.addEventListener('resync', () => resync());
  events.addEventListener('codex', event => {
    const message = JSON.parse(event.data);
    if (state.loading) bufferedEvents.push(message);
    applyEvent(state, message); changes.event(message); queue.event(message);
    if (message.method === 'bridge/subscriptionError' && message.params.threadId === state.selectedId) notice(message.params.message);
    scheduleRender();
  });
  events.onerror = () => {
    setConnection({ state: 'disconnected', errorKey: 'connection.browserLost' });
    api('/api/status').catch(error => { if (!$('login').hidden) showError($('login-error'), error); });
  };
}
async function resync() {
  if (!state.connected) return;
  await loadThreads().catch(error => notice(error));
  const target = state.selectedId || new URLSearchParams(location.hash.slice(1)).get('session');
  if (target) await openThread(target, true);
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
    button.append(el('div','session-row-title',sessionTitle(thread)));
    const meta = el('div','session-row-meta');
    const waiting = thread.status?.activeFlags?.length;
    meta.append(el('span', `status-dot ${waiting ? 'waiting' : thread.status?.type === 'active' ? 'active' : ''}`), el('span','path-short',projectTitle(thread.cwd)),el('time','',ago(thread.updatedAt)));
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
  state.selectedId = id; state.loading = true; state.ready = false; bufferedEvents = [];
  history.replaceState(null, '', `#session=${encodeURIComponent(id)}`);
  if (!resyncing || state.thread?.id !== id) { state.turns = []; state.thread = state.threads.find(t => t.id === id) || { id }; }
  $('welcome').hidden = true; $('session-view').hidden = false;
  changes.selectThread(id); queue.selectThread(id);
  setSidebar(false); renderAll();
  try {
    const response = await api(`/api/threads/${encodeURIComponent(id)}/open`, {});
    if (version !== openVersion) return;
    state.thread = response.thread;
    state.thread.model ||= response.model;
    const page = await api(`/api/threads/${encodeURIComponent(id)}/turns`);
    if (version !== openVersion) return;
    state.turns = mergeTurns([], [...page.data].reverse());
    turnsCursor = page.nextCursor;
    for (const message of bufferedEvents) {
      if (message.id === undefined && message.bridgeSequence > page.bridgeSequence) applyEvent(state, message);
    }
    bufferedEvents = [];
    state.ready = true; changes.refresh(); queue.refresh();
  } catch (error) {
    if (version === openVersion) notice(error);
  } finally {
    if (version === openVersion) { state.loading = false; renderAll(!resyncing); }
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
  const pattern = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\[[^\]\n]+\]\(https?:\/\/[^\s)]+\))/g;
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
function markdown(text) {
  const node = el('div','message-body');
  const parts = String(text).split(/```[^\n]*\n([\s\S]*?)(?:```|$)/g);
  parts.forEach((part,index) => { if (index % 2) { const pre = el('pre'); pre.append(el('code','',part)); node.append(pre); } else inline(node,part); });
  return node;
}
function renderItem(item) {
  if (item.type === 'userMessage' || item.type === 'agentMessage') {
    const user = item.type === 'userMessage';
    const wrapper = el('article',`message ${user ? 'user' : 'agent'}`);
    wrapper.dataset.itemId = item.id;
    const label = el('div','message-label');
    label.append(el('span','avatar',user ? t('session.you').slice(0, 1) : '⌘'),document.createTextNode(user ? t('session.you') : 'Codex'));
    wrapper.append(label);
    const text = user ? (item.content || []).map(c => c.text || (c.type === 'image' || c.type === 'localImage' ? t('session.image') : `[${c.type}]`)).join('\n') : item.text || '';
    wrapper.append(user ? el('div','message-body',text) : markdown(text));
    for (const q of item.questions || []) {
      const card = el('div','request-card'); card.append(el('p','',q.title));
      const actions = el('div','request-actions');
      for (const option of q.options || []) { const b = el('button','',option); b.onclick = () => { $('message').value = option; drafts.set(state.selectedId, option); $('message').focus(); renderControls(); }; actions.append(b); }
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
  details.append(el('pre','',text || t('tool.waiting')));
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
      const node = renderItem(item);
      if (expanded.has(item.id) && node.tagName === 'DETAILS') node.open = true;
      fragment.append(node);
    }
    if (turn.error) fragment.append(el('div','turn-error', turn.error.message || t('error.codex')));
    if (turn.status === 'interrupted') fragment.append(el('div','turn-marker',t('status.interrupted')));
  }
  $('messages').replaceChildren(fragment);
  $('older-turns').hidden = !turnsCursor || state.loading;
  $('activity').hidden = !state.connected || !isWorking(state);
  timeline.scrollTop = bottom ? timeline.scrollHeight : scrollTop;
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
}
function renderRequests() {
  const requests = [...state.requests.values()].filter(r => r.params?.threadId === state.selectedId);
  const signature = JSON.stringify(requests);
  if (signature === requestSignature) return;
  requestSignature = signature;
  const fragment = document.createDocumentFragment();
  for (const request of requests) {
    const card = el('form','request-card');
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
      try { await api('/api/respond',{ id: request.id, ...payload }); state.requests.delete(JSON.stringify(request.id)); renderRequests(); }
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
  try { await api('/api/logout',{}); drafts.clear(); queue.reset(); changes.selectThread(null); Object.assign(state,createState()); $('message').value=''; $('messages').replaceChildren(); $('requests').replaceChildren(); $('session-list').replaceChildren(); $('session-view').hidden=true; $('welcome').hidden=false; history.replaceState(null,'',location.pathname);showLogin(); }
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
$('message').onkeydown=event=>{queue.keydown(event);if(event.key==='Enter'&&!event.shiftKey&&!event.isComposing){event.preventDefault();if(!$('send').disabled)$('composer').requestSubmit();}};
$('composer').onsubmit=event=>{event.preventDefault();queue.submit();};
$('interrupt').onclick=async()=>{const turn=activeTurn(state);if(!turn)return;try{await api(`/api/threads/${encodeURIComponent(state.selectedId)}/interrupt`,{turnId:turn.id});}catch(error){notice(error);}};
window.addEventListener('hashchange',()=>{const id=new URLSearchParams(location.hash.slice(1)).get('session');if(id&&id!==state.selectedId)openThread(id);});
setInterval(()=>{if(state.connected&&!document.hidden&&!state.loading)loadThreads().catch(()=>{});},30000);
const changes = initChanges({ api, getState: () => state });
const queue = initQueue({ api, getState: () => state, notice, renderApp: renderAll, saveDraft: (id, text) => drafts.set(id, text) });
const projects = initProjects({ api, getDefaultCwd: () => state.thread?.cwd || defaultCwd, onCreated: async result => { await loadThreads(); await openThread(result.thread.id); } });
initPreferences(() => { renderConnection(); renderAll(); changes.render(); projects.render(); });
enter().catch(()=>showLogin());
