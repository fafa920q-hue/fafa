import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { sql } from '../../packages/db/src';
import { hashPassword } from '../../packages/auth/src/password';

const username = 'browser_' + randomUUID().replaceAll('-', '').slice(0, 12);
const email = username + '@example.invalid';
const password = 'synthetic browser password 中文测试';
let id: string;
test.beforeAll(async () => {
  const database = new URL(
    process.env.DATABASE_URL ||
      'postgres://fafa:fafa_dev_only@localhost:5432/fafa',
  );
  if (
    process.env.NODE_ENV === 'production' ||
    !['localhost', '127.0.0.1'].includes(database.hostname)
  )
    throw Error('浏览器账户夹具仅允许本地开发数据库');
  const [user] = await sql.unsafe(
    "INSERT INTO users(email,name,role) VALUES($1,$2,'Member') RETURNING id",
    [email, username],
  );
  id = user.id;
  await sql.unsafe(
    'INSERT INTO member_credentials(user_id,username,email_key,password_hash,email_verified_at) VALUES($1,$2,$3,$4,now())',
    [id, username, email, await hashPassword(password)],
  );
});
test.afterAll(async () => {
  if (id) {
    await sql.unsafe('UPDATE sessions SET revoked_at=now() WHERE owner_id=$1', [
      id,
    ]);
    await sql.unsafe('UPDATE users SET deleted_at=now() WHERE id=$1', [id]);
  }
  await sql.end();
});
test('普通账户实际密码登录、会话查看、退出及管理员隔离', async ({ page }) => {
  await page.goto('/member/login');
  await expect(
    page.getByRole('heading', { name: '普通账户登录', exact: true }),
  ).toBeVisible();
  await page.getByLabel('用户名或邮箱', { exact: true }).fill(username);
  await page
    .getByLabel('密码', { exact: true })
    .fill('incorrect fictional password');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('不正确');
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: '我的工作台', exact: true }),
  ).toBeVisible();
  await page.goto('/member/account');
  await expect(
    page.getByRole('heading', { name: '账户安全', exact: true }),
  ).toBeVisible();
  await expect(page.getByText('邮箱已验证', { exact: false })).toBeVisible();
  await expect(page.getByText('当前会话', { exact: true })).toBeVisible();
  await expect(
    page.getByRole('button', { name: '验证密码并绑定 Google', exact: true }),
  ).toBeEnabled();
  const denied = await page.request.get('/api/admin/users');
  expect(denied.status()).toBe(403);
  await page.getByRole('button', { name: '安全退出登录', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: '普通账户登录', exact: true }),
  ).toBeVisible();
  expect((await page.request.get('/api/me')).status()).toBe(401);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
test('邮箱服务缺失时不声称发送成功，激活链接不保留在地址栏', async ({
  page,
}) => {
  await page.goto('/member/register');
  await expect(
    page.getByRole('heading', { name: '注册普通账户', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('status').filter({ hasText: '邮件服务尚未配置' }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: '验证邮箱并创建账户', exact: true }),
  ).toBeDisabled();
  await page.getByRole('link', { name: '忘记密码', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: '忘记密码', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: '发送重置邮件', exact: true }),
  ).toBeDisabled();
  await page.goto('/member/verify#token=synthetic-not-a-real-action');
  await expect(
    page.getByLabel('注册时设置的密码', { exact: true }),
  ).toBeVisible();
  expect(new URL(page.url()).hash).toBe('');
  await expect(
    page.getByRole('link', { name: '使用 Google 登录', exact: true }),
  ).toHaveAttribute('href', '/auth/google');
});
