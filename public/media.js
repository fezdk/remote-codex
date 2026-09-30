import { t } from './i18n.js';
const $ = id => document.getElementById(id);
const MAX_BYTES = 8 * 1024 * 1024, MAX_COUNT = 4;
const node = (tag, cls, text) => { const value = document.createElement(tag); value.className = cls; if (text != null) value.textContent = text; return value; };
export const inputImages = parts => (parts || []).map(part => part.remoteImage).filter(Boolean);
const safeImage = value => typeof value === 'string' && /^\/api\/threads\/[a-zA-Z0-9_-]{1,160}\/images\/[a-f0-9]{64}$/.test(value);

export function initMedia({ api, getState, notice, renderApp }) {
  const drafts = new Map(), galleries = new Map(); let generation = 0;
  const current = () => getState().selectedId;
  const list = id => drafts.get(id) || [];
  const replace = (id, entries) => { drafts.set(id, entries); if (current() === id) renderApp(); };
  function open(image) {
    if (!safeImage(image.url)) return;
    $('image-view').src = image.url; $('image-view').alt = image.name || t('media.image');
    $('image-download').href = `${image.url}?download=1`;
    $('image-dialog').showModal();
  }
  function gallery(images, compact = false, key) {
    const cacheKey = key && `${current()}:${key}`;
    const signature = JSON.stringify([images, compact, document.documentElement.lang]);
    const cached = galleries.get(cacheKey);
    if (cached?.signature === signature) return cached.container;
    const container = node('div', `image-gallery${compact ? ' compact' : ''}`);
    for (const image of images || []) {
      const figure = node('figure', 'image-card');
      if (safeImage(image.url)) {
        const button = node('button', 'image-preview'); button.type = 'button'; button.title = t('media.open');
        const img = node('img', ''); img.src = image.url; img.alt = image.name || t('media.image'); img.loading = 'lazy'; img.decoding = 'async';
        const error = node('span', 'image-error', t('media.unavailable')); error.hidden = true;
        img.onerror = () => { img.hidden = true; error.hidden = false; button.disabled = true; };
        button.append(img,error); button.onclick = () => open(image); figure.append(button);
      } else if (typeof image.externalUrl === 'string' && /^https?:\/\//.test(image.externalUrl)) {
        const link = node('a', 'image-external', t('media.external')); link.href = image.externalUrl; link.target = '_blank'; link.rel = 'noopener noreferrer'; figure.append(link);
      } else figure.append(node('span','image-error', t('media.unavailable')));
      container.append(figure);
    }
    if (cacheKey) {
      if (galleries.size >= 500) galleries.delete(galleries.keys().next().value);
      galleries.set(cacheKey, { signature, container });
    }
    return container;
  }
  async function add(files) {
    const id = current(), epoch = generation;
    if (!id || $('attach-image').disabled) return;
    const chosen = [...files];
    if (!chosen.length) return;
    if (list(id).length + chosen.length > MAX_COUNT) return notice(t('media.count'));
    if (chosen.some(file => file.size > MAX_BYTES)) return notice(t('media.size'));
    if (chosen.some(file => !['image/png','image/jpeg','image/webp','image/gif'].includes(file.type))) return notice(t('media.invalid'));
    const entries = chosen.map(file => ({ name: file.name, uploading: true, key: {} }));
    replace(id,[...list(id),...entries]);
    await Promise.all(entries.map(async (entry,index) => {
      try {
        const data = await new Promise((resolve,reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(chosen[index]); });
        if (epoch !== generation || !list(id).includes(entry)) return;
        entry.preview = data; if (id === current()) renderApp();
        const uploaded = await api(`/api/threads/${encodeURIComponent(id)}/images`, { name: entry.name, data });
        if (epoch !== generation || !list(id).includes(entry)) return;
        Object.assign(entry,uploaded); delete entry.preview;
      } catch (error) {
        if (epoch !== generation || !list(id).includes(entry)) return;
        entry.error = true; notice(error);
      } finally {
        if (epoch === generation && list(id).includes(entry)) { entry.uploading = false; if (id === current()) renderApp(); }
      }
    }));
  }
  function render() {
    const state = getState(), entries = list(current());
    $('attach-image').disabled = !state.connected || !state.ready || state.loading || state.thread?.canAcceptDirectInput === false;
    const fragment = document.createDocumentFragment();
    for (const entry of entries) {
      const card = node('div','attachment');
      if (entry.preview || safeImage(entry.url)) { const img = entry.thumbnail ||= node('img',''); const src = entry.preview || entry.url; if (img.getAttribute('src') !== src) img.src = src; img.alt = entry.name || t('media.image'); card.append(img); }
      const caption = node('span','', entry.uploading ? t('media.uploading') : entry.error ? t('media.uploadFailed') : entry.name || t('media.image')); card.append(caption);
      const remove = node('button','attachment-remove','×'); remove.type = 'button'; remove.setAttribute('aria-label',t('media.remove',{name:entry.name || t('media.image')}));
      remove.onclick = () => replace(current(),list(current()).filter(other => other !== entry)); card.append(remove); fragment.append(card);
    }
    $('attachments').replaceChildren(fragment); $('attachments').hidden = !entries.length;
  }
  $('attach-image').onclick = () => $('image-files').click();
  $('image-files').onchange = event => { add(event.target.files); event.target.value = ''; };
  $('message').addEventListener('paste', event => {
    const files = [...event.clipboardData?.items || []].filter(item => item.kind === 'file').map(item => item.getAsFile()).filter(Boolean);
    if (files.length) { event.preventDefault(); add(files); }
  });
  const conversation = document.querySelector('.conversation');
  conversation.addEventListener('dragover', event => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); conversation.classList.add('image-drag'); } });
  conversation.addEventListener('dragleave', event => { if (!conversation.contains(event.relatedTarget)) conversation.classList.remove('image-drag'); });
  conversation.addEventListener('drop', event => { conversation.classList.remove('image-drag'); if (event.dataTransfer.files.length) { event.preventDefault(); add(event.dataTransfer.files); } });
  $('image-close').onclick = () => $('image-dialog').close();
  $('image-dialog').addEventListener('close', () => { $('image-view').removeAttribute('src'); $('image-download').removeAttribute('href'); });
  $('image-view').onerror = () => notice(t('media.unavailable'));
  return {
    render, gallery, list, has: id => list(id).length > 0,
    busy: id => list(id).some(entry => entry.uploading || entry.error || !entry.id),
    snapshot: id => [...list(id)],
    parts: id => list(id).map(remoteImage => ({ type:'image', remoteImage: {id:remoteImage.id,url:remoteImage.url,name:remoteImage.name} })),
    set: (id, images) => { drafts.set(id,images.map(image => ({...image,key:{}}))); },
    clearSent: (id, images) => { drafts.set(id,list(id).filter(entry => !images.includes(entry))); },
    reset() { ++generation; drafts.clear(); galleries.clear(); $('image-dialog').close(); $('image-files').value = ''; $('attachments').replaceChildren(); },
  };
}
