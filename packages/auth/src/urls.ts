export function publicOrigin() {
  const url = new URL(
    process.env.API_PUBLIC_URL ||
      process.env.WEB_ORIGIN ||
      'http://localhost:5173',
  );
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  )
    throw Error('API_PUBLIC_URL 必须是不含路径的公共 Origin');
  return url.origin;
}
export function googleRedirectUri() {
  return process.env.GOOGLE_REDIRECT_URI ||
    new URL('/auth/google/callback', publicOrigin()).toString();
}
export function assertPublicUrls() {
  if (process.env.NODE_ENV !== 'production') return;
  const web = new URL(process.env.WEB_ORIGIN || '');
  const admin = new URL(process.env.ADMIN_ORIGIN || '');
  if (
    web.origin !== 'https://fafa888.uk' ||
    web.href !== web.origin + '/' ||
    admin.origin !== 'https://a.fafa888.uk' ||
    admin.href !== admin.origin + '/' ||
    publicOrigin() !== web.origin ||
    googleRedirectUri() !== web.origin + '/auth/google/callback'
  )
    throw Error('生产域名必须为 fafa888.uk 与 a.fafa888.uk，OAuth 回调必须使用主域名');
}
