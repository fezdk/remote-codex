import { t, showError, errorText } from './i18n.js';
const $ = id => document.getElementById(id);
export function initProjects({ api, getDefaultCwd, onCreated }) {
  let result = null, failure = null, checking = false, submitting = false, version = 0, generation = 0, timer, selected = -1;
  function render() {
    const choices = result?.suggestions || [];
    const fragment = document.createDocumentFragment();
    choices.forEach((choice, index) => {
      const option = document.createElement('li'); option.id = `project-option-${index}`; option.setAttribute('role', 'option'); option.setAttribute('aria-selected', String(index === selected));
      const path = document.createElement('span'); path.textContent = choice.path;
      const source = document.createElement('small'); source.textContent = t(`projects.${choice.source}`);
      option.append(path, source); option.onmousedown = event => event.preventDefault(); option.onclick = () => choose(index); fragment.append(option);
    });
    $('project-suggestions').replaceChildren(fragment);
    const expanded = !checking && choices.length > 0;
    $('project-suggestions').hidden = !expanded;
    $('cwd').setAttribute('aria-expanded', String(expanded));
    if (expanded && selected >= 0) $('cwd').setAttribute('aria-activedescendant', `project-option-${selected}`);
    else $('cwd').removeAttribute('aria-activedescendant');
    const statusKey = checking ? 'projects.checking' : `projects.${result?.state || 'empty'}`;
    $('project-status').textContent = failure ? errorText(failure) : t(statusKey) + (result?.truncated ? ` ${t('projects.more')}` : '');
    $('create-directory-option').hidden = checking || result?.state !== 'missing' || !result.canCreate;
    $('project-status').classList.toggle('error', Boolean(failure) || ['invalid', 'file', 'unavailable'].includes(result?.state));
    const remote = result?.state === 'remote' && $('cwd').value.trim().startsWith('/');
    const valid = result?.state === 'directory' || result?.state === 'missing' && result.canCreate && $('create-directory').checked || remote;
    $('create-session').disabled = checking || submitting || !valid;
    $('create-session-label').textContent = t($('create-directory').checked && result?.state === 'missing' ? 'projects.createAndStart' : 'dialog.create');
    $('cwd').disabled = submitting; $('create-directory').disabled = submitting;
  }
  async function lookup() {
    const revision = ++version, value = $('cwd').value; checking = true; failure = null; selected = -1; render();
    try { const response = await api(`/api/projects?${new URLSearchParams({ path: value })}`); if (revision === version) result = response; }
    catch (error) { if (revision === version) { result = null; failure = error; } }
    finally { if (revision === version) { checking = false; render(); } }
  }
  function choose(index) {
    const choice = result?.suggestions[index]; if (!choice || submitting) return;
    $('cwd').value = choice.path; $('create-directory').checked = false; $('cwd').focus(); lookup();
  }
  $('cwd').oninput = () => {
    clearTimeout(timer); ++version; result = null; failure = null; checking = true; selected = -1; $('create-directory').checked = false; $('new-error').textContent = ''; render(); timer = setTimeout(lookup, 180);
  };
  $('cwd').onkeydown = event => {
    const count = result?.suggestions?.length || 0;
    if (event.isComposing || checking || !count) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault(); selected = event.key === 'ArrowDown' ? (selected + 1) % count : (selected <= 0 ? count : selected) - 1; render(); $(`project-option-${selected}`).scrollIntoView({ block: 'nearest' });
    } else if (event.key === 'Enter' && selected >= 0) { event.preventDefault(); choose(selected); }
    else if (event.key === 'Escape' && !$('project-suggestions').hidden) { event.preventDefault(); event.stopPropagation(); result = { ...result, suggestions: [] }; selected = -1; render(); }
  };
  $('create-directory').onchange = render;
  $('close-dialog').onclick = () => $('new-dialog').close();
  $('new-dialog').addEventListener('close', () => { clearTimeout(timer); ++version; });
  $('new-dialog').addEventListener('cancel', event => { if (submitting) event.preventDefault(); });
  $('new-form').onsubmit = async event => {
    event.preventDefault(); if ($('create-session').disabled) return;
    const epoch = generation;
    const cwd = result?.path || $('cwd').value.trim();
    const createDirectory = result?.state === 'missing' && $('create-directory').checked;
    submitting = true; $('new-error').textContent = ''; $('close-dialog').disabled = true; render();
    try { const response = await api('/api/threads', { cwd, ...(createDirectory ? { createDirectory: true } : {}) }); if (epoch !== generation) return; $('new-dialog').close(); await onCreated(response); }
    catch (error) { if (epoch !== generation) return; showError($('new-error'), error); await lookup(); }
    finally { if (epoch === generation) { submitting = false; $('close-dialog').disabled = false; render(); } }
  };
  return { render, reset() { ++generation; ++version; clearTimeout(timer); $('new-dialog').close(); result = null; failure = null; submitting = false; checking = false; $('new-form').reset(); $('new-error').textContent = ''; $('close-dialog').disabled = false; render(); }, open() { if (submitting) return; $('cwd').value = getDefaultCwd() || ''; $('new-error').textContent = ''; $('create-directory').checked = false; result = null; $('new-dialog').showModal(); lookup(); } };
}
