try {
  document.documentElement.dataset.theme =
    localStorage.getItem('fafa_theme') === 'dark' ? 'dark' : 'light';
} catch (e) {
  document.documentElement.dataset.theme = 'light';
}
