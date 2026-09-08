import { messages, languages } from './locales.js';

export function translate(language, key, values = {}, fallback = key) {
  const template = messages[language]?.[key] ?? messages.da[key] ?? fallback;
  return template.replace(/\{(\w+)\}/g, (match, name) => Object.hasOwn(values, name) ? String(values[name]) : match);
}

export function t(key, values, fallback) {
  return translate(document.documentElement.lang, key, values, fallback);
}

// Known UI/bridge errors have translation keys; unknown upstream diagnostics remain verbatim.
export function errorText(error) {
  if (error?.errorKey) return t(error.errorKey, {}, error.message);
  return typeof error === 'string' ? error : error?.message || t('error.connection');
}

export function showError(node, error) {
  node.textContent = errorText(error);
  if (error?.errorKey) node.dataset.errorKey = error.errorKey;
  else delete node.dataset.errorKey;
}

export function applyTranslations(root = document) {
  for (const [attribute, target] of [['data-i18n', null], ['data-i18n-placeholder', 'placeholder'], ['data-i18n-title', 'title'], ['data-i18n-aria', 'aria-label']]) {
    for (const node of root.querySelectorAll(`[${attribute}]`)) {
      const text = t(node.getAttribute(attribute), JSON.parse(node.dataset.i18nValues || '{}'));
      if (target) node.setAttribute(target, text);
      else node.textContent = text;
    }
  }
  for (const node of root.querySelectorAll('[data-error-key]')) if (node.textContent) node.textContent = t(node.dataset.errorKey);
}

export function initPreferences(onLanguageChange) {
  if (!Object.hasOwn(languages, document.documentElement.lang)) window.remoteCodexPreferences.set('language', 'da');
  for (const select of document.querySelectorAll('[data-language-select]')) {
    for (const [code, name] of Object.entries(languages)) {
      const option = document.createElement('option'); option.value = code; option.textContent = name; option.lang = code; select.append(option);
    }
    select.addEventListener('change', () => window.remoteCodexPreferences.set('language', select.value));
  }
  for (const button of document.querySelectorAll('[data-theme-toggle]')) {
    button.addEventListener('click', () => window.remoteCodexPreferences.set('theme', document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'));
  }
  const update = () => {
    applyTranslations();
    for (const select of document.querySelectorAll('[data-language-select]')) select.value = document.documentElement.lang;
    const dark = document.documentElement.dataset.theme === 'dark';
    for (const button of document.querySelectorAll('[data-theme-toggle]')) {
      button.textContent = dark ? '☀' : '☾';
      button.setAttribute('aria-label', t(dark ? 'settings.light' : 'settings.dark'));
      button.title = button.getAttribute('aria-label');
    }
  };
  window.addEventListener('preferenceschange', event => {
    update();
    onLanguageChange();
  });
  update();
}
