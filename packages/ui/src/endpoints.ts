// Vite replaces this per independent build. Development stays same-origin.
const origin = (import.meta.env.VITE_API_ORIGIN || '').replace(/\/$/, '');
export function backendUrl(path: string, base = origin) {
  if (!/^\/(api(?:\/|$)|auth(?:\/|$)|subscription\/)/.test(path))
    throw Error('无效的后端路径');
  if (path.startsWith('/api/api/')) throw Error('重复的 API 前缀');
  return base.replace(/\/$/, '') + path;
}
export function terminalUrl(path: string, pageOrigin: string) {
  const url = new URL(backendUrl(path), pageOrigin);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}
