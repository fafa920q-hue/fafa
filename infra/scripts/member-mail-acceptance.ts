import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { assertPublicUrls } from '../../packages/auth/src/urls';
import { mailApiKey } from '../../packages/auth/src/mail-secret';

type Result = {
  configuration: 'VALID' | 'INVALID';
  provider: 'NOT_TESTED' | 'ACCEPTED' | 'REJECTED' | 'NETWORK_ERROR';
  inbox: 'REQUIRES_ACCOUNT_HOLDER';
  accountFlow: 'NOT_TESTED';
  productionChanged: false;
  code?: string;
  status?: number;
  reference?: string;
};
function invalid(code: string): Result {
  return {
    configuration: 'INVALID',
    provider: 'NOT_TESTED',
    inbox: 'REQUIRES_ACCOUNT_HOLDER',
    accountFlow: 'NOT_TESTED',
    productionChanged: false,
    code,
  };
}
const mailbox = /^[^\s<>@\r\n]+@[^\s<>@\r\n]+\.[^\s<>@\r\n]+$/;
export async function verifyMemberMail(send = false): Promise<Result> {
  if (
    process.env.MAIL_PROVIDER !== 'resend' ||
    !/^\S+$/.test(mailApiKey()) ||
    !mailbox.test(process.env.MAIL_FROM || '')
  )
    return invalid('MAIL_UNCONFIGURED');
  if (process.env.NODE_ENV !== 'production')
    return invalid('PRODUCTION_URL_CONFIGURATION_REQUIRED');
  try {
    assertPublicUrls();
  } catch {
    return invalid('PUBLIC_URL_CONFIGURATION_INVALID');
  }
  const result: Result = {
    configuration: 'VALID',
    provider: 'NOT_TESTED',
    inbox: 'REQUIRES_ACCOUNT_HOLDER',
    accountFlow: 'NOT_TESTED',
    productionChanged: false,
  };
  if (!send) return result;
  if (process.env.MAIL_ACCEPTANCE_CONFIRM !== 'send-to-owned-mailbox')
    return invalid('ACCOUNT_HOLDER_APPROVAL_REQUIRED');
  if (!mailbox.test(process.env.MAIL_ACCEPTANCE_TO || ''))
    return invalid('OWNED_MAILBOX_REQUIRED');
  const reference = randomUUID();
  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(8000),
      headers: {
        authorization: 'Bearer ' + mailApiKey(),
        'content-type': 'application/json',
        'idempotency-key': 'fafa-member-acceptance-' + reference,
      },
      body: JSON.stringify({
        from: process.env.MAIL_FROM,
        to: [process.env.MAIL_ACCEPTANCE_TO],
        subject: 'FAFA ONE 邮件通道验收 ' + reference,
        text:
          '这是账户持有人批准的单封邮件通道测试。\n核对编号：' +
          reference +
          '\n此邮件不含激活链接、重置凭据或任何登录权限。实际收到后才能确认邮箱投递；API接受请求不代表进入收件箱。',
      }),
    });
    await response.body?.cancel();
    return {
      ...result,
      provider: response.ok ? 'ACCEPTED' : 'REJECTED',
      status: response.status,
      reference,
    };
  } catch {
    return {
      ...result,
      provider: 'NETWORK_ERROR',
      code: 'MAIL_NETWORK_ERROR',
      reference,
    };
  }
}
async function main() {
  const args = process.argv.slice(2);
  if (
    args.some((arg) => !['--check', '--send'].includes(arg)) ||
    args.length > 1
  ) {
    console.log(JSON.stringify(invalid('USAGE_CHECK_OR_SEND')));
    process.exitCode = 1;
    return;
  }
  const result = await verifyMemberMail(args[0] === '--send');
  // No addresses, API key, provider body, action tokens or exception stack are printed.
  console.log(JSON.stringify(result));
  if (
    result.configuration !== 'VALID' ||
    ['REJECTED', 'NETWORK_ERROR'].includes(result.provider)
  )
    process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch(() => {
    console.log(JSON.stringify(invalid('MAIL_ACCEPTANCE_FAILED')));
    process.exitCode = 1;
  });
