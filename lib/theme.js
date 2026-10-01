/**
 * Applies the Theme setting to the extension's own pages by setting
 * data-theme="light" | "dark" on <html>. Loaded as a classic script in <head>
 * so the right colours are there on first paint: chrome.storage is async, so
 * the last choice is mirrored in localStorage (shared by all extension pages).
 */
(() => {
  const CACHE = 'study-buddy-theme';
  const systemDark = window.matchMedia('(prefers-color-scheme: dark)');
  let choice = localStorage.getItem(CACHE) || 'auto';

  const apply = () => {
    const dark = choice === 'dark' || (choice !== 'light' && systemDark.matches);
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  };
  const adopt = (settings) => {
    choice = (settings && settings.theme) || 'auto';
    localStorage.setItem(CACHE, choice);
    apply();
  };

  apply();
  systemDark.addEventListener('change', apply);
  chrome.storage.local.get('settings', (stored) => adopt(stored.settings));
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.settings) adopt(changes.settings.newValue);
  });
})();
