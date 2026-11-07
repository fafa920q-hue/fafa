import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { verifyMemberMail } from '../infra/scripts/member-mail-acceptance';

beforeEach(() => {
  vi.stubEnv('NODE_ENV', 'production');
  vi.stubEnv('WEB_ORIGIN', 'https://fafa888.uk');
  vi.stubEnv('ADMIN_ORIGIN', 'https://a.fafa888.uk');
  vi.stubEnv('API_PUBLIC_URL', 'https://fafa888.uk');
  vi.stubEnv('GOOGLE_REDIRECT_URI', 'https://fafa888.uk/auth/google/callback');
  vi.stubEnv('MAIL_PROVIDER', 'resend');
  vi.stubEnv('MAIL_API_KEY', 'synthetic-key-not-a-real-provider-credential');
  vi.stubEnv('MAIL_FROM', 'accounts@example.invalid');
  vi.stubEnv('MAIL_ACCEPTANCE_TO', 'holder@example.invalid');
  vi.stubEnv('MAIL_ACCEPTANCE_CONFIRM', '');
  vi.stubGlobal('fetch', vi.fn());
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
it('默认只验证配置，不发送邮件或声称投递', async () => {
  expect(await verifyMemberMail()).toMatchObject({
    configuration: 'VALID',
    provider: 'NOT_TESTED',
    inbox: 'REQUIRES_ACCOUNT_HOLDER',
    productionChanged: false,
  });
  expect(fetch).not.toHaveBeenCalled();
});
it('缺少邮件配置、错误公共URL或未批准时拒绝真实请求', async () => {
  vi.stubEnv('MAIL_API_KEY', '');
  expect((await verifyMemberMail(true)).code).toBe('MAIL_UNCONFIGURED');
  vi.stubEnv('MAIL_API_KEY', 'synthetic-key-not-a-real-provider-credential');
  vi.stubEnv('API_PUBLIC_URL', 'https://evil.invalid');
  expect((await verifyMemberMail(true)).code).toBe(
    'PUBLIC_URL_CONFIGURATION_INVALID',
  );
  vi.stubEnv('API_PUBLIC_URL', 'https://fafa888.uk');
  expect((await verifyMemberMail(true)).code).toBe(
    'ACCOUNT_HOLDER_APPROVAL_REQUIRED',
  );
  expect(fetch).not.toHaveBeenCalled();
});
it('收件地址非法或包含换行时失败关闭', async () => {
  vi.stubEnv('MAIL_ACCEPTANCE_CONFIRM', 'send-to-owned-mailbox');
  vi.stubEnv(
    'MAIL_ACCEPTANCE_TO',
    'holder@example.invalid\nbcc:other@example.invalid',
  );
  expect((await verifyMemberMail(true)).code).toBe('OWNED_MAILBOX_REQUIRED');
  expect(fetch).not.toHaveBeenCalled();
});
it('单次批准只发送一封无凭据测试邮件，接受不冒充收件成功', async () => {
  vi.stubEnv('MAIL_ACCEPTANCE_CONFIRM', 'send-to-owned-mailbox');
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, options: any) => {
      expect(url).toBe('https://api.resend.com/emails');
      expect(options.redirect).toBe('error');
      const body = JSON.parse(options.body);
      expect(body.to).toEqual(['holder@example.invalid']);
      expect(body.text).not.toContain('#token=');
      expect(body.text).not.toContain('/member/verify');
      return new Response('{}', { status: 200 });
    }),
  );
  const result = await verifyMemberMail(true);
  expect(result).toMatchObject({
    provider: 'ACCEPTED',
    inbox: 'REQUIRES_ACCOUNT_HOLDER',
    accountFlow: 'NOT_TESTED',
  });
  expect(fetch).toHaveBeenCalledTimes(1);
  const serialized = JSON.stringify(result);
  for (const value of [
    'accounts@example.invalid',
    'holder@example.invalid',
    process.env.MAIL_API_KEY!,
  ])
    expect(serialized).not.toContain(value);
});
it('提供商错误和网络异常只返回脱敏状态，无敏感正文或自动重试', async () => {
  vi.stubEnv('MAIL_ACCEPTANCE_CONFIRM', 'send-to-owned-mailbox');
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response('synthetic private provider response', { status: 422 }),
    ),
  );
  const rejected = await verifyMemberMail(true);
  expect(rejected).toMatchObject({ provider: 'REJECTED', status: 422 });
  expect(JSON.stringify(rejected)).not.toContain('private provider response');
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw Error('synthetic private network details');
    }),
  );
  const network = await verifyMemberMail(true);
  expect(network.provider).toBe('NETWORK_ERROR');
  expect(JSON.stringify(network)).not.toContain('private network details');
  expect(fetch).toHaveBeenCalledTimes(1);
});
