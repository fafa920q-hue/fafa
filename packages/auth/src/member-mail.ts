import { AppError } from '../../shared/src';
import { publicOrigin } from './urls';

export type AccountMail = {
  to: string;
  purpose: 'VERIFY' | 'RESET';
  raw: string;
};
const pending = new Set<Promise<void>>();
export function mailConfigured() {
  return (
    process.env.MAIL_PROVIDER === 'resend' &&
    !!process.env.MAIL_API_KEY?.trim() &&
    /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(process.env.MAIL_FROM || '')
  );
}
export function requireAccountMail() {
  if (!mailConfigured())
    throw new AppError(
      503,
      'MAIL_UNCONFIGURED',
      '邮件服务尚未配置，暂时无法注册或找回密码，请联系管理员',
    );
  if (pending.size >= 32)
    throw new AppError(503, 'MAIL_BUSY', '邮件服务繁忙，请稍后重试');
}
// Raw credentials exist only in request memory and the HTTPS email request, never in the DB.
export function queueAccountMail(
  mail: AccountMail,
  onFailure: () => Promise<void>,
) {
  const task = Promise.resolve()
    .then(async () => {
      const route =
        mail.purpose === 'VERIFY' ? '/member/verify' : '/member/reset';
      const url = new URL(route, publicOrigin());
      // Fragment prevents credentials from entering HTTP access logs or Referer headers.
      url.hash = new URLSearchParams({ token: mail.raw }).toString();
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(8000),
        headers: {
          authorization: 'Bearer ' + process.env.MAIL_API_KEY,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          from: process.env.MAIL_FROM,
          to: [mail.to],
          subject:
            mail.purpose === 'VERIFY'
              ? 'FAFA ONE 邮箱激活'
              : 'FAFA ONE 密码重置',
          text:
            (mail.purpose === 'VERIFY'
              ? '请打开以下链接，并输入注册时设置的密码完成激活。链接30分钟内有效。'
              : '请打开以下链接设置新密码。链接15分钟内有效，成功后所有旧会话失效。') +
            '\n\n' +
            url.toString() +
            '\n\n若非本人操作，请忽略本邮件。不要分享此链接。',
        }),
      });
      if (!response.ok) throw new Error('邮件服务未接受请求');
      await response.body?.cancel();
    })
    .catch(async () => {
      // No provider body/error, recipient, password, token or URL enters logs.
      await onFailure().catch(() => {});
    })
    .finally(() => pending.delete(task));
  pending.add(task);
}
export async function settleAccountMail() {
  await Promise.all([...pending]);
}
