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
      for (const section of sections) {
        fragment.append(node('h3', '', section.title || t(section.key)));
        const block = node('div', 'diff-block'), pre = node('pre', '');
        for (const line of section.diff.split('\n')) {
          const kind = line.startsWith('@@') ? 'hunk' : line.startsWith('+') && !line.startsWith('+++') ? 'add' : line.startsWith('-') && !line.startsWith('---') ? 'remove' : '';
          pre.append(node('span', `diff-line ${kind}`, line));
        }
        block.append(pre); fragment.append(block);
      }
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
      event.preventDefault(); const next = event.key === 'Home' ? 'codex' : event.key === 'End' ? 'git' : source === 'codex' ? 'git' : 'codex';
      $(`${next}-tab`).click(); $(`${next}-tab`).focus();
    };
  }
  $('changes-panel').onkeydown = event => { if (event.key === 'Escape') show(false); };
  return { render, selectThread, refresh, event(message) {
    if (message.params?.threadId !== threadId) return;
    if (message.method === 'turn/completed' || message.method === 'item/completed' && message.params.item?.type === 'fileChange') { clearTimeout(timer); timer = setTimeout(refresh, 650); }
  } };
}
