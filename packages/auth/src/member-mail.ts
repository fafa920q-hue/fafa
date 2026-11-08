import { randomUUID } from 'node:crypto';
import { sql } from '../../db/src';
import { AppError } from '../../shared/src';
import { publicOrigin } from './urls';
import { mailApiKey } from './mail-secret';

export type AccountMail = {
  to: string;
  purpose:
    | 'VERIFY'
    | 'RESET'
    | 'CODE'
    | 'VERIFIED'
    | 'RESET_SUCCESS'
    | 'PASSWORD_CHANGED';
  raw?: string;
  ownerId?: string;
};
const pending = new Set<Promise<void>>();
let transmitting = 0;
export function mailConfigured() {
  return (
    process.env.MAIL_PROVIDER === 'resend' &&
    !!mailApiKey() &&
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
const subjects = {
  VERIFY: 'FAFA ONE 邮箱激活',
  RESET: 'FAFA ONE 密码重置',
  CODE: 'FAFA ONE 注册验证码',
  VERIFIED: 'FAFA ONE 邮箱验证成功',
  RESET_SUCCESS: 'FAFA ONE 密码重置成功通知',
  PASSWORD_CHANGED: 'FAFA ONE 密码修改安全通知',
};
const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c
      ]!,
  );
export function renderAccountMail(mail: AccountMail) {
  let text: string;
  if (mail.purpose === 'VERIFY' || mail.purpose === 'RESET') {
    const url = new URL(
      mail.purpose === 'VERIFY' ? '/member/verify' : '/member/reset',
      publicOrigin(),
    );
    url.hash = new URLSearchParams({ token: mail.raw || '' }).toString();
    text =
      (mail.purpose === 'VERIFY'
        ? '请打开以下链接，并输入注册时设置的密码完成激活。链接30分钟内有效。'
        : '请打开以下链接设置新密码。链接15分钟内有效，成功后所有旧会话失效。') +
      '\n\n' +
      url.toString();
  } else if (mail.purpose === 'CODE') {
    text =
      '你的注册验证码：' +
      mail.raw +
      '\n验证码10分钟内有效，最多尝试5次。请返回注册页面输入验证码和原注册密码。不要向他人提供验证码。';
  } else {
    text =
      mail.purpose === 'VERIFIED'
        ? '你的邮箱已验证，普通账户已激活。你可以进入个人中心管理账户安全。'
        : '你的密码已成功更新，原有会话已撤销。若非本人操作，请立即通过忘记密码重置，并联系管理员。';
  }
  text +=
    '\n\n若非本人操作，请忽略验证请求；安全通知请及时核查。FAFA ONE 不会索取你的密码或验证码。';
  return {
    subject: subjects[mail.purpose],
    text,
    html:
      '<!doctype html><html lang="zh-CN"><meta name="viewport" content="width=device-width, initial-scale=1"><body style="margin:0;background:#f3f5ff;color:#283047;font-family:system-ui,sans-serif"><main style="max-width:560px;margin:24px auto;padding:24px;background:#fff;border-radius:16px;overflow-wrap:anywhere"><h1 style="font-size:22px">' +
      escapeHtml(subjects[mail.purpose]) +
      '</h1><p style="line-height:1.8;white-space:pre-wrap">' +
      escapeHtml(text) +
      '</p></main></body></html>',
  };
}
export async function deliverAccountMail(mail: AccountMail) {
  const id = randomUUID();
  await sql.unsafe(
    "INSERT INTO member_mail_events(id,owner_id,purpose,status) VALUES($1,$2,$3,'PENDING')",
    [id, mail.ownerId || null, mail.purpose],
  );
  let status: number | null = null;
  let active = false;
  try {
    if (!mailConfigured())
      throw new AppError(503, 'MAIL_UNCONFIGURED', '邮件服务尚未配置');
    if (transmitting >= 32)
      throw new AppError(503, 'MAIL_BUSY', '邮件服务繁忙');
    transmitting++;
    active = true;
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(8000),
      headers: {
        authorization: 'Bearer ' + mailApiKey(),
        'content-type': 'application/json',
        'idempotency-key': id,
      },
      body: JSON.stringify({
        from: 'FAFA ONE <' + process.env.MAIL_FROM + '>',
        to: [mail.to],
        ...renderAccountMail(mail),
      }),
    });
    status = response.status;
    await response.body?.cancel();
    if (!response.ok) throw Error('PROVIDER_REJECTED');
    await sql.unsafe(
      "UPDATE member_mail_events SET status='ACCEPTED',provider_status=$2,updated_at=now() WHERE id=$1",
      [id, status],
    );
    return { id, status: 'ACCEPTED' as const };
  } catch (caught) {
    await sql.unsafe(
      "UPDATE member_mail_events SET status='FAILED',failure_code=$2,provider_status=$3,updated_at=now() WHERE id=$1",
      [
        id,
        caught instanceof AppError
          ? caught.code
          : status === null
            ? 'MAIL_NETWORK_ERROR'
            : 'PROVIDER_REJECTED',
        status,
      ],
    );
    throw new AppError(
      503,
      'MAIL_SEND_FAILED',
      '邮件服务暂时无法发送，请稍后重试；此次不表示发送成功',
    );
  } finally {
    if (active) transmitting--;
  }
}
export function queueAccountMail(
  mail: AccountMail,
  onFailure: () => Promise<void>,
) {
  const task = Promise.resolve()
    .then(() => deliverAccountMail(mail))
    .then(() => {})
    .catch(async () => {
      await onFailure().catch(() => {});
    })
    .finally(() => pending.delete(task));
  pending.add(task);
}
export async function settleAccountMail() {
  await Promise.all([...pending]);
}
