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
// 登录来源只区分前台与管理后台两个固定值；生产按域名区分，开发按端口区分。
export function loginApp(hostname: string, port: string): 'web' | 'admin' {
  if (hostname === 'a.fafa888.uk' || port === '5174') return 'admin';
  return 'web';
}
