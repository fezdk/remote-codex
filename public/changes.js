import { t, errorText } from './i18n.js';

const $ = id => document.getElementById(id);
const node = (tag, className, text) => { const el = document.createElement(tag); el.className = className; if (text != null) el.textContent = text; return el; };

export function initChanges({ api, getState }) {
  const desktop = matchMedia('(min-width: 1201px)');
  const splitter = $('changes-resizer'), container = splitter.parentElement;
  let preferredWidth = 350, drag = null;
  try { const saved = Number(localStorage.getItem('remote-codex.changes-width')); if (Number.isFinite(saved) && saved >= 280 && saved <= 10000) preferredWidth = saved; } catch { /* Resizing also works without storage. */ }
  let threadId, source = 'codex', visible = desktop.matches;
  let files = [], selection = null, detail = null, busy = false, failure = null, truncated = false, revision = 0, detailRevision = 0, timer;
  let plan = null, planBusy = false, planFailure = null, planRevision = 0;
  function widthLimits() {
    return { min: 280, max: Math.max(280, container.clientWidth - 360 - 8) };
  }
  function resize() {
    splitter.hidden = !visible || !desktop.matches;
    if (splitter.hidden) { finishDrag(false); return; }
    if (!container.clientWidth) return;
    const { min, max } = widthLimits();
    const width = Math.round(Math.min(max, Math.max(min, preferredWidth)));
    container.style.setProperty('--changes-width', `${width}px`);
    splitter.setAttribute('aria-valuemin', String(min)); splitter.setAttribute('aria-valuemax', String(max)); splitter.setAttribute('aria-valuenow', String(width));
    splitter.setAttribute('aria-valuetext', t('changes.width', { width }));
  }
  function saveWidth() { try { localStorage.setItem('remote-codex.changes-width', String(preferredWidth)); } catch { /* Keep the width for this page. */ } }
  function finishDrag(save = true) {
    if (!drag) return;
    const previous = drag; drag = null;
    if (!save) preferredWidth = previous.preference;
    document.body.classList.remove('resizing-changes');
    if (splitter.hasPointerCapture(previous.id)) splitter.releasePointerCapture(previous.id);
    if (save) saveWidth();
    resize();
  }
  splitter.onpointerdown = event => {
    if (event.button !== 0 || drag || !desktop.matches) return;
    event.preventDefault(); splitter.focus();
    drag = { id: event.pointerId, x: event.clientX, width: $('changes-panel').getBoundingClientRect().width, preference: preferredWidth };
    splitter.setPointerCapture(event.pointerId); document.body.classList.add('resizing-changes');
  };
  splitter.onpointermove = event => {
    if (!drag || event.pointerId !== drag.id) return;
    const { min, max } = widthLimits(); preferredWidth = Math.min(max, Math.max(min, drag.width + drag.x - event.clientX)); resize();
  };
  splitter.onpointerup = event => { if (event.pointerId === drag?.id) finishDrag(); };
  splitter.onpointercancel = () => finishDrag(false);
  splitter.onlostpointercapture = () => finishDrag(false);
  splitter.ondblclick = () => { preferredWidth = 350; resize(); saveWidth(); };
  splitter.onkeydown = event => {
    if (event.key === 'Escape' && drag) { event.preventDefault(); finishDrag(false); return; }
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key) || drag) return;
    event.preventDefault(); const { min, max } = widthLimits(), current = Number(splitter.getAttribute('aria-valuenow'));
    const step = event.shiftKey ? 80 : 20;
    preferredWidth = event.key === 'Home' ? min : event.key === 'End' ? max : Math.min(max, Math.max(min, current + (event.key === 'ArrowLeft' ? step : -step)));
    resize(); saveWidth();
  };
  new ResizeObserver(resize).observe(container);
  desktop.addEventListener('change', resize);
  function render() {
    $('changes-panel').hidden = !visible;
    resize();
    $('toggle-changes').setAttribute('aria-expanded', String(visible));
    for (const tab of document.querySelectorAll('[data-source]')) { const selected = tab.dataset.source === source; tab.setAttribute('aria-selected', String(selected)); tab.tabIndex = selected ? 0 : -1; }
    $('changes-content').setAttribute('aria-labelledby', `${source}-tab`);
    if (source === 'tasks') { renderPlan(); return; }
    $('changes-description').textContent = t(source === 'codex' ? 'changes.codexDescription' : 'changes.gitDescription');
    $('changes-summary').textContent = failure ? errorText(failure) : busy ? t('changes.loading') : files.length ? t(files.length === 1 ? 'changes.oneFile' : 'changes.count', { count: files.length }) + (truncated ? `\n${t('changes.truncated')}` : '') : t(source === 'codex' ? 'changes.emptyCodex' : 'changes.emptyGit');
    $('changes-summary').classList.toggle('error', Boolean(failure));
    const list = document.createDocumentFragment();
    for (const file of files) {
      const button = node('button', 'changed-file'); button.type = 'button'; button.setAttribute('aria-pressed', String(file.path === selection));
      const kind = t(`changes.${file.kind}`, {}, file.kind);
      button.title = `${kind}: ${file.path}`;
      const badge = node('span', `file-badge ${file.kind === 'delete' ? 'deleted' : ''}`, { add: '+', delete: '−', rename: 'R', untracked: '?', update: 'M' }[file.kind] || 'M'); badge.setAttribute('aria-label', kind);
      button.append(badge, node('span', 'file-path', file.path));
      if (source === 'codex') {
        const stats = node('span', 'diff-stats'); stats.append(node('span', 'diff-added', `+${file.added} `), node('span', 'diff-removed', `−${file.removed}`)); button.append(stats);
      }
      button.onclick = () => selectFile(file.path);
      list.append(button);
    }
    $('changed-files').replaceChildren(list);
    renderDetail();
  }
  function renderPlan() {
    const scroll = $('changes-content').scrollTop;
    $('changes-description').textContent = t('tasks.description');
    const status = planFailure ? errorText(planFailure) : planBusy && !plan ? t('changes.loading') : !plan ? t('tasks.empty') : t('tasks.progress',{done:plan.steps.filter(step=>step.status==='completed').length,total:plan.steps.length});
    $('changes-summary').textContent = status;
    $('changes-summary').classList.toggle('error',Boolean(planFailure));
    $('changed-files').replaceChildren(); $('change-detail').replaceChildren();
    const content = document.createDocumentFragment();
    if (!getState().connected || plan?.stale) content.append(node('p','task-note',t('tasks.stale')));
    if (plan) {
      if (plan.previousTurn) content.append(node('p','task-note',t('tasks.previous')));
      if (plan.turnStatus !== 'inProgress') content.append(node('p','task-note',t(`tasks.turn.${plan.turnStatus}`,{},t('tasks.turn.unknown'))));
      if (plan.explanation) content.append(node('p','task-explanation',plan.explanation));
      if (plan.steps.length) {
        const progress = node('progress','task-progress'); progress.max = plan.steps.length; progress.value = plan.steps.filter(step=>step.status==='completed').length; progress.setAttribute('aria-label',status); content.append(progress);
        const list = node('ol','task-list');
        for (const step of plan.steps) {
          const row = node('li',`task-step ${step.status}`), mark = node('span','task-mark',{pending:'○',inProgress:'◉',completed:'✓'}[step.status]); mark.setAttribute('aria-hidden','true');
          const body = node('div','task-body'); body.append(node('span','task-text',step.step),node('span','task-state',t(`tasks.${step.status}`))); row.append(mark,body); list.append(row);
        }
        content.append(list);
      } else content.append(node('p','task-note',t('tasks.cleared')));
      if (plan.truncated) content.append(node('p','task-note',t('tasks.truncated')));
    }
    $('change-detail').append(content); $('changes-content').scrollTop = scroll;
  }
  async function refreshPlan() {
    const version = ++planRevision, id = threadId; planBusy = true; planFailure = null; render();
    try { const result = await api(`/api/threads/${encodeURIComponent(id)}/plan`); if (version === planRevision) plan = result.plan; }
    catch (error) { if (version === planRevision) planFailure = error; }
    finally { if (version === planRevision) { planBusy = false; render(); } }
  }
  function renderDetail() {
    const fragment = document.createDocumentFragment();
    const file = files.find(file => file.path === selection);
    if (!file) { if (files.length) fragment.append(node('p', 'change-note', t('changes.select'))); }
    else {
      fragment.append(node('h3', '', file.path));
      if (file.previousPath) fragment.append(node('p', 'change-note', t('changes.from', { path: file.previousPath })));
      const sections = source === 'codex' ? file.patches.map((patch, index) => ({ diff: patch.diff, title: t('changes.patch', { number: index + 1, turn: patch.turnId.slice(0, 8) }) })) : detail?.sections || [];
      if (source === 'git' && !detail) fragment.append(node('p', 'change-note', t('changes.loading')));
      if (detail?.error) fragment.append(node('p', 'error', errorText(detail.error)));
      if (detail?.note) fragment.append(node('p', 'change-note', t(detail.note)));
      if (detail?.truncated) fragment.append(node('p', 'change-note', t('changes.truncated')));
      let linesLeft = 5000, charsLeft = 200000, limited = false;
      for (const section of sections) {
        if (!linesLeft || !charsLeft) { limited = true; break; }
        fragment.append(node('h3', '', section.title || t(section.key)));
        const block = node('div', 'diff-block'), pre = node('pre', '');
        if (section.diff.length > charsLeft) limited = true;
        for (const line of section.diff.slice(0, charsLeft).split('\n')) {
          if (!linesLeft--) { linesLeft = 0; limited = true; break; }
          charsLeft = Math.max(0, charsLeft - line.length - 1);
          const kind = line.startsWith('@@') ? 'hunk' : line.startsWith('+') && !line.startsWith('+++') ? 'add' : line.startsWith('-') && !line.startsWith('---') ? 'remove' : '';
          pre.append(node('span', `diff-line ${kind}`, line));
        }
        block.append(pre); fragment.append(block);
      }
      if (limited) fragment.append(node('p', 'change-note', t('changes.truncated')));
    }
    const scroll = $('changes-content').scrollTop;
    $('change-detail').replaceChildren(fragment);
    $('changes-content').scrollTop = scroll;
  }
  async function selectFile(path) {
    selection = path; detail = null; const version = ++detailRevision; render();
    if (source !== 'git') return;
    try {
      const result = await api(`/api/threads/${encodeURIComponent(threadId)}/git-diff?path=${encodeURIComponent(path)}`);
      if (version === detailRevision) detail = result;
    } catch (error) { if (version === detailRevision) detail = { error }; }
    if (version === detailRevision) renderDetail();
  }
  async function refresh() {
    if (!threadId || !visible || !getState().connected) return;
    if (source === 'tasks') return refreshPlan();
    const version = ++revision; busy = true; failure = null; render();
    try {
      const result = await api(`/api/threads/${encodeURIComponent(threadId)}/${source === 'codex' ? 'changes' : 'git'}`);
      if (version !== revision) return;
      files = result.files; truncated = result.truncated;
      if (!files.some(file => file.path === selection)) { selection = null; detail = null; ++detailRevision; }
      if (selection && source === 'git') selectFile(selection);
    } catch (error) { if (version === revision) { failure = error; files = []; detail = null; ++detailRevision; } }
    finally { if (version === revision) { busy = false; render(); } }
  }
  function selectThread(id) {
    if (threadId === id) return;
    threadId = id; busy = false; files = []; selection = null; detail = null; failure = null; truncated = false; ++revision; ++detailRevision;
    plan = null; planBusy = false; planFailure = null; ++planRevision; clearTimeout(timer);
    render(); refresh();
  }
  function show(open) {
    visible = open; render();
    if (open) { refresh(); $('close-changes').focus(); }
    else $('toggle-changes').focus();
  }
  $('toggle-changes').onclick = () => show(!visible);
  $('close-changes').onclick = () => show(false);
  $('refresh-changes').onclick = refresh;
  for (const tab of document.querySelectorAll('[data-source]')) {
    tab.onclick = () => { source = tab.dataset.source; files = []; selection = null; detail = null; failure = null; truncated = false; ++revision; ++detailRevision; render(); refresh(); };
    tab.onkeydown = event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault(); const sources = ['codex','git','tasks']; const next = event.key === 'Home' ? sources[0] : event.key === 'End' ? sources.at(-1) : sources[(sources.indexOf(source) + (event.key === 'ArrowRight' ? 1 : 2)) % sources.length];
      $(`${next}-tab`).click(); $(`${next}-tab`).focus();
    };
  }
  $('changes-panel').onkeydown = event => { if (event.key === 'Escape') show(false); };
  return { render, selectThread, refresh, event(message) {
    if (message.params?.threadId !== threadId) return;
    if (Object.hasOwn(message.params || {},'remotePlan')) {
      ++planRevision; planBusy = false; planFailure = null; plan = message.params.remotePlan.plan;
      if (source === 'tasks') render();
    }
    if (source === 'tasks') return;
    if (message.method === 'turn/completed' || message.method === 'item/completed' && message.params.item?.type === 'fileChange') { clearTimeout(timer); timer = setTimeout(refresh, 650); }
  } };
}
