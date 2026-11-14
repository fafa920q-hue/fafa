import { test, expect } from '@playwright/test';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
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
        page.getByRole('button', { name: '验证邮箱并创建账户', exact: true }),
      ).toBeDisabled();
      await page.getByLabel('用户名', { exact: true }).fill('layout_user');
      await page
        .getByLabel('邮箱', { exact: true })
        .fill('layout@example.invalid');
      await page.getByLabel('密码', { exact: true }).fill(password);
      await page
        .getByLabel('确认密码', { exact: true })
        .fill('a different synthetic password');
      await page.getByRole('checkbox', { name: /我已阅读并同意/ }).check();
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
  await page.getByRole('checkbox', { name: /我已阅读并同意/ }).check();
  await page.getByRole('button', { name: '发送验证码', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('已由邮件服务接受');
  const first = await code(email),
    bad = first === '000000' ? '111111' : '000000';
  await page.getByLabel('邮箱验证码', { exact: true }).fill(bad);
  await page
    .getByRole('button', { name: '验证邮箱并创建账户', exact: true })
    .click();
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
  await page
    .getByRole('button', { name: '验证邮箱并创建账户', exact: true })
    .click();
  await expect(
    page.getByRole('heading', { name: '我的工作台', exact: true }),
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
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: '我的工作台', exact: true }),
  ).toBeVisible();
  expect(
    (await context.cookies()).find((c) => c.name === 'fafa_session')?.expires,
  ).toBe(-1);
  await page.getByRole('button', { name: '安全退出登录', exact: true }).click();
  await page.getByLabel('用户名或邮箱', { exact: true }).fill(username);
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByRole('checkbox', { name: '记住登录状态' }).check();
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: '我的工作台', exact: true }),
  ).toBeVisible();
  expect(
    (await context.cookies()).find((c) => c.name === 'fafa_session')!.expires,
  ).toBeGreaterThan(Date.now() / 1000);
  await page.goto('/member/forgot');
  await page.getByLabel('邮箱', { exact: true }).fill(email);
  await page.getByRole('button', { name: '发送重置邮件', exact: true }).click();
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
  await page.getByRole('button', { name: '设置新密码', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('密码已重置');
  expect((await old.request.get('/api/me')).status()).toBe(401);
  await expect
    .poll(() => messages(email).some((m) => m.subject.includes('重置成功通知')))
    .toBe(true);
  await page.goto('/member/login');
  await page.getByLabel('用户名或邮箱', { exact: true }).fill(username);
  await page.getByLabel('密码', { exact: true }).fill(next);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: '我的工作台', exact: true }),
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
  await page.getByRole('checkbox', { name: /我已阅读并同意/ }).check();
  await page.getByRole('button', { name: '发送验证码', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('邮件服务暂时无法发送');
  await expect(
    page.getByRole('button', { name: '发送验证码', exact: true }),
  ).toBeEnabled();
  await expect(
    page.getByRole('button', { name: '验证邮箱并创建账户', exact: true }),
  ).toBeDisabled();
});

test('认证交互：密码可见性、记住状态和协议入口', async ({ page }) => {
  await page.goto('/member/login');
  const input = page.getByLabel('密码', { exact: true });
  await input.fill('synthetic visibility password');
  await expect(input).toHaveAttribute('type', 'password');
  await page.getByRole('button', { name: '显示密码', exact: true }).click();
  await expect(input).toHaveAttribute('type', 'text');
  await page.getByRole('button', { name: '隐藏密码', exact: true }).click();
  await expect(input).toHaveAttribute('type', 'password');
  await expect(
    page.getByRole('checkbox', { name: '记住登录状态' }),
  ).not.toBeChecked();
  await page.getByRole('checkbox', { name: '记住登录状态' }).check();
  await expect(
    page.getByRole('checkbox', { name: '记住登录状态' }),
  ).toBeChecked();
  await expect(
    page.getByRole('link', { name: '使用 Google 登录' }),
  ).toHaveAttribute('href', '/auth/google');
  await page.getByRole('link', { name: '隐私政策', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: '隐私政策', exact: true }),
  ).toBeVisible();
});
test('不同意协议时不发送注册邮件', async ({ page }) => {
  await page.goto('/member/register');
  await page.getByLabel('用户名', { exact: true }).fill('consent_layout');
  await page
    .getByLabel('邮箱', { exact: true })
    .fill('consent_layout@example.invalid');
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByLabel('确认密码', { exact: true }).fill(password);
  let sent = 0;
  page.on('request', (r) => {
    if (r.url().endsWith('/auth/member/registration/start')) sent++;
  });
  await page.getByRole('button', { name: '发送验证码', exact: true }).click();
  expect(sent).toBe(0);
  await expect(
    page.getByRole('checkbox', { name: /我已阅读并同意/ }),
  ).not.toBeChecked();
  expect(
    await page
      .getByRole('checkbox', { name: /我已阅读并同意/ })
      .evaluate((input: HTMLInputElement) => input.validity.valueMissing),
  ).toBe(true);
});

test('认证页面视觉与手机溢出检查', async ({ page }, testInfo) => {
  const folder =
    process.env.FAFA_TEST_SCREENSHOT_DIR || 'docs/screenshots/member-auth';
  mkdirSync(folder, { recursive: true });
  for (const mode of ['login', 'register', 'forgot']) {
    await page.goto('/member/' + mode);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: folder + '/auth-' + mode + '-' + testInfo.project.name + '.jpg',
      type: 'jpeg',
      quality: 60,
      fullPage: true,
      animations: 'disabled',
    });
  }
});

test('用户工作台：节点展示、管理员授权、独立订阅和撤销', async ({
  page,
  browser,
}) => {
  const { seal } = await import('../../packages/shared/src/crypto');
  const name = 'catalog_' + randomUUID().replaceAll('-', '').slice(0, 12),
    email = name + '@example.invalid';
  const sourceId = randomUUID(),
    nodeId = randomUUID(),
    nodeName = 'platform_' + randomUUID().slice(0, 8);
  const [owner] =
    await sql`SELECT id FROM users WHERE role='Owner' AND deleted_at IS NULL LIMIT 1`;
  expect(owner).toBeTruthy();
  await sql`INSERT INTO node_sources(id,owner_id,data) VALUES(${sourceId},${owner.id},${sql.json({ name: nodeName, kind: 'OWNED_NODE', authorized: true, enabled: true })})`;
  const node = {
    name: nodeName,
    protocol: 'ss',
    host: '203.0.113.77',
    port: 443,
    cipher: 'aes-128-gcm',
    credential: 'synthetic-not-real-password',
    country: '日本',
    tls: false,
    transport: 'tcp',
  };
  await sql`INSERT INTO nodes(id,owner_id,source_id,data,secret) VALUES(${nodeId},${owner.id},${sourceId},${sql.json({ name: nodeName, protocol: 'ss', country: '日本', enabled: true })},${sql.json(seal(JSON.stringify(node)))})`;
  const adminContext = await browser.newContext();
  try {
    await page.goto('/member/register');
    await page.getByLabel('用户名', { exact: true }).fill(name);
    await page.getByLabel('邮箱', { exact: true }).fill(email);
    await page.getByLabel('密码', { exact: true }).fill(password);
    await page.getByLabel('确认密码', { exact: true }).fill(password);
    await page.getByRole('checkbox', { name: /我已阅读并同意/ }).check();
    await page.getByRole('button', { name: '发送验证码', exact: true }).click();
    await page
      .getByLabel('邮箱验证码', { exact: true })
      .fill(await code(email));
    await page
      .getByRole('button', { name: '验证邮箱并创建账户', exact: true })
      .click();
    await expect(
      page.getByRole('heading', { name: '我的工作台', exact: true }),
    ).toBeVisible();
    const me = await (await page.request.get('/api/me')).json();
    expect(me.user.role).toBe('Member');
    await page.goto('/subscriptions');
    const card = page.getByRole('article').filter({ hasText: nodeName });
    await expect(card).toBeVisible();
    await expect(
      card.getByRole('button', { name: '未开放订阅', exact: true }),
    ).toBeDisabled();
    await expect(
      page.getByRole('button', { name: '添加节点', exact: true }),
    ).toHaveCount(0);
    const admin = 'http://localhost:5174';
    const adminPage = await adminContext.newPage();
    await adminPage.goto(admin);
    await adminPage
      .getByRole('button', { name: '管理员演示', exact: true })
      .click();
    await expect(
      adminPage.getByRole('heading', { name: '管理概览', exact: true }),
    ).toBeVisible();
    const administrator = await (
      await adminPage.request.get(admin + '/api/me')
    ).json();
    const capability = await adminPage.request.patch(
      admin + '/api/admin/access/users/' + me.user.id,
      {
        data: { node: { enabled: true }, nodeLimit: 20 },
        headers: { Origin: admin, 'x-csrf-token': administrator.csrf },
      },
    );
    expect(capability.status()).toBe(200);
    await page.getByRole('button', { name: '刷新节点', exact: true }).click();
    await expect(
      card.getByRole('button', { name: '未开放订阅', exact: true }),
    ).toBeDisabled();
    await adminPage.goto(admin + '/users');
    await adminPage
      .getByRole('combobox', { name: '选择普通用户', exact: true })
      .selectOption(me.user.id);
    await adminPage.getByText('节点分配', { exact: true }).click();
    await adminPage
      .getByRole('combobox', { name: '选择节点源', exact: true })
      .selectOption(sourceId);
    await adminPage
      .getByRole('listbox', { name: '选择节点（可多选）', exact: true })
      .selectOption(nodeId);
    await adminPage
      .getByRole('button', { name: '保存节点分配', exact: true })
      .click();
    await expect(adminPage.getByRole('status')).toContainText('权限已保存');
    await page.getByRole('button', { name: '刷新节点', exact: true }).click();
    await expect(card.getByText('已获使用授权', { exact: true })).toBeVisible();
    await expect(
      card.getByRole('link', { name: '管理订阅', exact: true }),
    ).toBeVisible();
    await card.getByRole('link', { name: '管理订阅', exact: true }).click();
    await expect(
      page.getByRole('heading', { name: '我的订阅', exact: true }),
    ).toBeVisible();
    await page.getByRole('checkbox', { name: new RegExp(nodeName) }).check();
    await page
      .getByRole('button', { name: '生成独立订阅链接', exact: true })
      .click();
    const link = page.getByLabel('你的独立订阅链接', { exact: true });
    await expect(link).toHaveValue(/\/api\/subscription\/download\//);
    const value = await link.inputValue();
    const downloaded = await page.request.get(value);
    expect(downloaded.status()).toBe(200);
    page.once('dialog', (dialog) => void dialog.accept());
    await page
      .getByRole('button', { name: '撤销现有订阅链接', exact: true })
      .click();
    await expect(page.getByRole('status')).toContainText('订阅链接已撤销');
    expect((await page.request.get(value)).status()).toBe(404);
    await page
      .getByRole('button', { name: '生成独立订阅链接', exact: true })
      .click();
    await expect(link).toHaveValue(/\/api\/subscription\/download\//);
    const next = await link.inputValue();
    await sql`UPDATE users SET node_access_until=now()-interval '1 second' WHERE id=${me.user.id}`;
    expect((await page.request.get(next)).status()).toBe(403);
    await page.goto('/subscriptions');
    await expect(
      page
        .getByRole('article')
        .filter({ hasText: nodeName })
        .getByRole('button', { name: '未开放订阅', exact: true }),
    ).toBeDisabled();
  } finally {
    await adminContext.close();
    await sql`UPDATE node_sources SET revoked_at=now() WHERE id=${sourceId}`;
    await sql`UPDATE nodes SET revoked_at=now() WHERE id=${nodeId}`;
  }
});

test('后台统一管理：服务时段、注册体验策略与普通用户AI额度', async ({
  page,
}, testInfo) => {
  const admin = 'http://localhost:5174';
  await page.goto(admin);
  await page.getByRole('button', { name: '管理员演示', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: '管理概览', exact: true }),
  ).toBeVisible();
  const original = await (
    await page.request.get(admin + '/api/admin/service-policy')
  ).json();
  const me = await (await page.request.get(admin + '/api/me')).json();
  const registration = await (
    await page.request.get(admin + '/api/admin/member-registration')
  ).json();
  const screenshotDir = process.env.FAFA_TEST_SCREENSHOT_DIR;
  const desktop = testInfo.project.name === 'chromium';
  if (desktop) await page.setViewportSize({ width: 1536, height: 1024 });
  try {
    await page.goto(admin + '/member-registration');
    await expect(
      page.getByRole('heading', { name: '普通账户注册', exact: true }),
    ).toBeVisible();
    const nav = page.getByRole('navigation', { name: '注册设置分区' });
    const seat = page.getByRole('spinbutton', {
      name: '注册人数上限（所有有效用户共用）',
    });
    await expect(seat).toBeVisible();
    await expect(page.locator('.reg-seat-count')).toHaveText(/\d+\s*\/\s*\d+/);
    await expect(
      page.locator('.reg-metric .reg-status').filter({ hasText: '读取中' }),
    ).toHaveCount(0);
    await expect(
      page.getByRole('heading', { name: '首次三天自动授权', exact: true }),
    ).toHaveCount(0);
    const hasHorizontalOverflow = () =>
      page.evaluate(
        () => document.documentElement.scrollWidth > window.innerWidth + 1,
      );
    expect(await hasHorizontalOverflow()).toBe(false);
    if (screenshotDir && (desktop || testInfo.project.name === 'iphone')) {
      await page.evaluate(() => document.fonts.ready);
      await page.screenshot({
        path:
          screenshotDir +
          '/registration-' +
          (desktop ? 'desktop' : 'iphone') +
          '.png',
        fullPage: desktop,
        animations: 'disabled',
      });
    }

    await seat.fill('100');
    await nav
      .getByRole('button', { name: '注册体验策略', exact: true })
      .click();
    await expect(
      page.getByRole('spinbutton', { name: '体验时长（小时）' }),
    ).toBeVisible();
    await expect(seat).toBeHidden();
    await nav
      .getByRole('button', { name: '全站限时开放', exact: true })
      .click();
    await expect(
      page
        .locator('#reg-panel-campaign')
        .getByLabel('开始时间（UTC）', { exact: true }),
    ).toBeVisible();
    expect(await hasHorizontalOverflow()).toBe(false);
    if (screenshotDir && desktop) {
      await page.screenshot({
        path: screenshotDir + '/registration-campaign-desktop.png',
        fullPage: true,
        animations: 'disabled',
      });
    }
    await nav
      .getByRole('button', { name: '自由注册设置', exact: true })
      .click();
    await expect(seat).toHaveValue('100');
    await page
      .getByRole('button', { name: '保存自由注册设置', exact: true })
      .click();
    await expect(page.getByRole('status')).toContainText('注册策略已保存');
    const savedRegistration = await (
      await page.request.get(admin + '/api/admin/member-registration')
    ).json();
    expect(savedRegistration).toMatchObject({
      enabled: registration.enabled,
      seatLimit: 100,
    });
    await page.getByText('查看邮件记录', { exact: true }).click();
    await expect(
      page.getByText('提供商已接受仅代表受理。', { exact: false }),
    ).toBeVisible();

    await nav.getByRole('button', { name: 'AI 服务管理', exact: true }).click();
    await page.getByText('兼容设置 · 原全站服务时段', { exact: true }).click();
    await page
      .getByLabel('服务开始时间（UTC）', { exact: true })
      .fill('2026-11-08T00:10');
    await page
      .getByLabel('服务结束时间（UTC）', { exact: true })
      .fill('2026-11-09T00:20');
    await page.getByText('指定使用者', { exact: true }).click();
    const firstMember = page.locator('input[name="aiUserIds"]').first();
    await firstMember.check();
    const selectedMember = await firstMember.inputValue();
    await page
      .getByRole('searchbox', { name: '搜索指定使用者', exact: true })
      .fill('no-such-fixture-name');
    await expect(firstMember).toBeHidden();
    await page
      .getByLabel('每任务输出 token 上限', { exact: true })
      .fill('2100');
    await page
      .getByRole('button', { name: '保存服务策略', exact: true })
      .click();
    await expect(page.getByRole('status')).toContainText('服务策略已保存');
    const saved = await (
      await page.request.get(admin + '/api/admin/service-policy')
    ).json();
    expect(saved.ai.maxOutputTokens).toBe(2100);
    expect(saved.ai.enabled).toBe(false);
    expect(saved.ai.userIds).toContain(selectedMember);
    expect(saved.schedule.startsAt).toBe('2026-11-08T00:10:00.000Z');
    expect(saved.schedule.endsAt).toBe('2026-11-09T00:20:00.000Z');
    expect(saved.schedule.enabled).toBe(false);
    await expect(
      page.getByLabel('每任务输出 token 上限', { exact: true }),
    ).toHaveValue('2100');
    await page.goto(admin + '/users');
    await expect(
      page.getByRole('heading', { name: '用户权限中心', exact: true }),
    ).toBeVisible();
    await page
      .getByRole('combobox', { name: '选择普通用户', exact: true })
      .selectOption({ index: 1 });
    await expect(
      page.getByRole('button', { name: '保存用户权限', exact: true }),
    ).toBeVisible();
    const details = page
      .locator('details')
      .filter({ has: page.getByText('AI 额度管理', { exact: true }) })
      .first();
    await details.locator('summary').click();
    await expect(
      details.getByLabel('AI 每日次数（0停用）', { exact: true }),
    ).toBeVisible();
    await details.getByLabel('AI 每日次数（0停用）', { exact: true }).fill('3');
    await details
      .getByRole('button', { name: '保存用户 AI 额度', exact: true })
      .click();
    await expect(page.getByRole('status')).toContainText('用户 AI 额度已保存');
  } finally {
    await page.request.patch(admin + '/api/admin/member-registration', {
      data: {
        enabled: registration.enabled,
        seatLimit: registration.seatLimit,
      },
      headers: { Origin: admin, 'x-csrf-token': me.csrf },
    });
    await page.request.patch(admin + '/api/admin/service-policy', {
      data: original,
      headers: { Origin: admin, 'x-csrf-token': me.csrf },
    });
  }
});
