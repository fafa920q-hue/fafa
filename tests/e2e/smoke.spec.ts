import { test, expect } from '@playwright/test';
async function login(page: any, profile = '管理员演示') {
  await page.goto('/');
  await page.getByRole('button', { name: profile, exact: true }).click();
  await expect(
    page.getByRole('heading', { name: '欢迎使用 FAFA ONE 控制面板 👋' }),
  ).toBeVisible();
}
test('所有用户页面、真实位置写入与未配置能力说明', async ({ page }) => {
  await login(page);
  for (const [path, title] of [
    ['/subscriptions', '节点订阅'],
    ['/codex', 'Codex 工作台'],
    ['/servers', '我的服务器'],
    ['/locations', '位置中心'],
    ['/account', '我的账户'],
  ]) {
    await page.goto(path);
    await expect(
      page.getByRole('heading', { name: title, exact: true }).first(),
    ).toBeVisible();
    await expect(
      page.getByText('演示环境 · 样例均已标注，不连接外部代理、SSH 或 AI 服务'),
    ).toBeVisible();
  }
  await page.goto('/locations');
  await page.getByRole('button', { name: '添加位置预设' }).click();
  await page.getByLabel('地点名称').fill('浏览器验收 ' + Date.now());
  await page.getByLabel('纬度').fill('31.23');
  await page.getByLabel('经度').fill('121.47');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(
    page.getByRole('status').filter({ hasText: '位置预设已保存' }),
  ).toBeVisible();
  await expect(page.getByText('暂不支持 · 不会重启生效')).toBeVisible();
});
test('手机与桌面各宽度无横向溢出、暗色及键盘导航', async ({ page }, info) => {
  test.setTimeout(120000);
  await login(page);
  for (const width of [320, 375, 390, 430, 768, 1024, 1440, 1920]) {
    await page.setViewportSize({ width, height: 900 });
    for (const route of [
      '/',
      '/subscriptions',
      '/codex',
      '/servers',
      '/locations',
      '/account',
    ]) {
      await page.goto(route);
      await page.waitForLoadState('networkidle');
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
        `${route} at ${width}`,
      ).toBe(true);
    }
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.getByRole('button', { name: '切换主题' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: `docs/screenshots/mobile-dark-${info.project.name}.png`,
    fullPage: true,
    animations: 'disabled',
  });
  await page.getByRole('button', { name: '切换主题' }).click();
  await page.screenshot({
    path: `docs/screenshots/mobile-${info.project.name}.png`,
    fullPage: true,
    animations: 'disabled',
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({
    path: `docs/screenshots/desktop-${info.project.name}.png`,
    fullPage: true,
    animations: 'disabled',
  });
  await page.getByRole('button', { name: '搜索功能、节点、服务器…' }).click();
  await page.getByRole('textbox', { name: '搜索页面名称' }).fill('位置');
  await page.getByRole('button', { name: '位置中心', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: '位置中心', exact: true }),
  ).toBeVisible();
});
test('Viewer 只读、空状态与 API 强制隔离', async ({ page }) => {
  await login(page, '访客演示');
  await page.goto('/subscriptions');
  await expect(page.getByRole('button', { name: '添加订阅源' })).toHaveCount(0);
  await expect(
    page.getByRole('heading', { name: '暂无匹配的订阅源' }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: '生成 / 轮换链接' }),
  ).toBeDisabled();
  const result = await page.evaluate(async () => {
    const r = await fetch('/api/admin/users');
    return r.status;
  });
  expect(result).toBe(403);
  await page.goto('/servers');
  await expect(
    page.getByRole('button', { name: '添加服务器', exact: true }),
  ).toHaveCount(0);
});
test('独立管理端邀请真实写入与全部页面', async ({ page }) => {
  await page.goto('http://localhost:5174');
  await page.getByRole('button', { name: '管理员演示', exact: true }).click();
  await expect(page.getByRole('heading', { name: '管理概览' })).toBeVisible();
  await page.goto('http://localhost:5174/users');
  await page.getByRole('button', { name: '邀请用户', exact: true }).click();
  const email = `browser-${Date.now()}@example.invalid`;
  await page.getByLabel('Google 账号邮箱').fill(email);
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByText(email, { exact: true })).toBeVisible();
  for (const route of [
    'sources',
    'servers',
    'ai',
    'jobs',
    'audit',
    'settings',
  ]) {
    await page.goto('http://localhost:5174/' + route);
    await expect(page.locator('h1')).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  }
});
test('API 断网错误与重试状态', async ({ page }) => {
  await login(page);
  await page.route('**/api/node_sources', (route) =>
    route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ message: '测试：连接暂时不可用' }),
    }),
  );
  await page.goto('/subscriptions');
  await expect(
    page.getByRole('alert').filter({ hasText: '测试：连接暂时不可用' }).first(),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: '重试', exact: true }),
  ).toBeVisible();
});
