// Capture action credentials before React mounts, never in storage or rendered DOM.
function capture() {
  if (
    typeof window === 'undefined' ||
    !/^\/member\/(verify|reset)$/.test(window.location.pathname)
  )
    return '';
  const value =
    new URLSearchParams(window.location.hash.slice(1)).get('token') || '';
  if (window.location.hash)
    history.replaceState(null, '', window.location.pathname);
  return value;
}
let initial = capture();
export function consumeActionToken() {
  const value = initial || capture();
  initial = '';
  return value;
}
