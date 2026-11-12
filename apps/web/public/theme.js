/* global document: readonly, localStorage: readonly */
try {
  document.documentElement.dataset.theme =
    localStorage.getItem('fafa_theme') === 'dark' ? 'dark' : 'light';
} catch {
  document.documentElement.dataset.theme = 'light';
}
