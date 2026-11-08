import { test, expect } from '@playwright/test';
import { readFileSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { sql } from '../../packages/db/src';

const password = 'synthetic browser password 中文验证';
function messages(email: string) {
  try {
    return readFileSync(process.env.FAFA_TEST_MAIL_FILE!, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((mail) => mail.to[0] === email);
  } catch {
    return [];
  }
}
async function code(email: string) {
  await expect
    .poll(
      () =>
        messages(email).filter((mail) => mail.subject.includes('注册验证码'))
          .length,
    )
    .toBeGreaterThan(0);
  return messages(email)
    .filter((mail) => mail.subject.includes('注册验证码'))
    .at(-1)
    .text.match(/验证码：(\d{6})/)[1] as string;
}
test.beforeAll(async () => {
  const url = new URL(process.env.DATABASE_URL!);
  const localDocker =
    process.env.FAFA_LOCAL_MAIL_FIXTURE === 'disposable-docker' &&
    existsSync('/.dockerenv') &&
    /^\/fafa_member_browser_[a-f0-9]{12}_test$/.test(url.pathname) &&
    process.env.FAFA_TEST_MAIL_FILE?.startsWith('/tmp/');
  if (
    (process.env.GITHUB_ACTIONS !== 'true' && !localDocker) ||
    process.env.DEMO_MODE !== 'true' ||
    !['localhost', '127.0.0.1'].includes(url.hostname) ||
    !process.env.FAFA_TEST_MAIL_FILE
  )
    throw Error('Disposable CI mail transport required');
  await sql.unsafe(
    "UPDATE settings SET value='true' WHERE key='member_registration_open'",
  );
  await sql.unsafe("UPDATE settings SET value='1000' WHERE key='seat_limit'");
});
test.afterAll(async () => {
  await sql.end();
});
for (const width of [375, 390, 430, 768, 1440])
  for (const theme of ['light', 'dark'] as const) {
    test('验证码注册布局 ' + width + ' ' + theme, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ colorScheme: theme });
      await page.goto('/member/register');
      await expect(
        page.getByRole('heading', { name: '注册普通账户', exact: true }),
      ).toBeVisible();
      for (const name of ['用户名', '邮箱', '密码', '确认密码', '邮箱验证码'])
        await expect(page.getByLabel(name, { exact: true })).toBeVisible();
      await expect(
        page.getByRole('button', { name: '发送验证码', exact: true }),
      ).toBeEnabled();
      await expect(
        page.getByRole('button', { name: '确认', exact: true }),
      ).toBeDisabled();
      await page.getByLabel('用户名', { exact: true }).fill('layout_user');
      await page
        .getByLabel('邮箱', { exact: true })
        .fill('layout@example.invalid');
      await page.getByLabel('密码', { exact: true }).fill(password);
      await page
        .getByLabel('确认密码', { exact: true })
        .fill('a different synthetic password');
      await page
        .getByRole('button', { name: '发送验证码', exact: true })
        .click();
      await expect(page.getByRole('alert')).toContainText(
        '两次输入的密码不一致',
      );
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
    });
  }
test('真实数据库与API：验证码、重发、自动登录、找回及重置通知', async ({
  page,
  context,
}) => {
  const username = 'browser_' + randomUUID().replaceAll('-', '').slice(0, 12),
    email = username + '@example.invalid';
  await page.goto('/member/register');
  await page.getByLabel('用户名', { exact: true }).fill(username);
  await page.getByLabel('邮箱', { exact: true }).fill(email);
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByLabel('确认密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '发送验证码', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('已由邮件服务接受');
  const first = await code(email),
    bad = first === '000000' ? '111111' : '000000';
  await page.getByLabel('邮箱验证码', { exact: true }).fill(bad);
  await page.getByRole('button', { name: '确认', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText(
    '验证码或原注册密码不正确',
  );
  await page.getByRole('button', { name: '重发验证码', exact: true }).click();
  await expect
    .poll(
      () =>
        messages(email).filter((m) => m.subject.includes('注册验证码')).length,
    )
    .toBe(2);
  const latest = await code(email);
  expect(latest).not.toBe(first);
  await page.getByLabel('邮箱验证码', { exact: true }).fill(latest);
  await page.getByRole('button', { name: '确认', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: '账户安全', exact: true }),
  ).toBeVisible();
  await expect(page.getByText('邮箱已验证', { exact: false })).toBeVisible();
  expect((await page.request.get('/api/admin/users')).status()).toBe(403);
  await expect
    .poll(() => messages(email).some((m) => m.subject.includes('验证成功')))
    .toBe(true);
  const old = await context.newPage();
  await old.goto('/member/account');
  await page.getByRole('button', { name: '安全退出登录', exact: true }).click();
  await page.getByLabel('用户名或邮箱', { exact: true }).fill(email);
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '确认', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: '账户安全', exact: true }),
  ).toBeVisible();
  await page.goto('/member/forgot');
  await page.getByLabel('邮箱', { exact: true }).fill(email);
  await page.getByRole('button', { name: '确认', exact: true }).click();
  await expect
    .poll(() => messages(email).some((m) => m.subject === 'FAFA ONE 密码重置'))
    .toBe(true);
  const mail = messages(email)
    .filter((m) => m.subject === 'FAFA ONE 密码重置')
    .at(-1);
  const link = mail.text
    .split('\n')
    .find((line: string) => line.startsWith('http'));
  await page.goto(link);
  expect(new URL(page.url()).hash).toBe('');
  const next = 'synthetic changed browser password 中文';
  await page.getByLabel('新密码', { exact: true }).fill(next);
  await page.getByLabel('确认新密码', { exact: true }).fill(next);
  await page.getByRole('button', { name: '确认', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('密码已重置');
  expect((await old.request.get('/api/me')).status()).toBe(401);
  await expect
    .poll(() => messages(email).some((m) => m.subject.includes('重置成功通知')))
    .toBe(true);
  await page.goto('/member/login');
  await page.getByLabel('用户名或邮箱', { exact: true }).fill(username);
  await page.getByLabel('密码', { exact: true }).fill(next);
  await page.getByRole('button', { name: '确认', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: '账户安全', exact: true }),
  ).toBeVisible();
  await old.close();
});
test('提供商真实失败响应不能显示邮件发送成功', async ({ page }) => {
  const name = 'fail_' + randomUUID().replaceAll('-', '').slice(0, 12);
  await page.goto('/member/register');
  await page.getByLabel('用户名', { exact: true }).fill(name);
  await page
    .getByLabel('邮箱', { exact: true })
    .fill(name + '@example.invalid');
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByLabel('确认密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '发送验证码', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('邮件服务暂时无法发送');
  await expect(
    page.getByRole('button', { name: '发送验证码', exact: true }),
  ).toBeEnabled();
  await expect(
    page.getByRole('button', { name: '确认', exact: true }),
  ).toBeDisabled();
});
