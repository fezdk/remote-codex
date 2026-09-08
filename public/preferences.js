// Runs before CSS so a saved light/dark preference is applied before the first paint.
(() => {
  const root = document.documentElement;
  const systemTheme = matchMedia('(prefers-color-scheme: dark)');
  const read = key => { try { return localStorage.getItem(`remote-codex.${key}`); } catch { return null; } };
  const savedTheme = read('theme');
  let theme = ['light', 'dark'].includes(savedTheme) ? savedTheme : null;
  let language = read('language') || 'da';
  function apply() {
    root.dataset.theme = theme || (systemTheme.matches ? 'dark' : 'light');
    root.lang = language;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', root.dataset.theme === 'dark' ? '#111615' : '#f5f7f3');
  }
  function set(key, value) {
    if (key === 'theme') {
      if (!['light', 'dark'].includes(value)) return;
      theme = value;
    } else if (key === 'language') language = value;
    else return;
    try { localStorage.setItem(`remote-codex.${key}`, value); } catch { /* Preferences still work for this page. */ }
    apply();
    window.dispatchEvent(new CustomEvent('preferenceschange', { detail: { key } }));
  }
  window.remoteCodexPreferences = { set };
  systemTheme.addEventListener('change', () => {
    if (theme) return;
    apply(); window.dispatchEvent(new CustomEvent('preferenceschange', { detail: { key: 'theme' } }));
  });
  apply();
})();
