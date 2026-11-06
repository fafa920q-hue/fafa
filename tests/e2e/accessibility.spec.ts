import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
test('核心页面浅深色 WCAG A/AA 自动检查', async ({ page }, info) => {
  test.setTimeout(180000);
  test.skip(
    info.project.name !== 'chromium',
    '相同页面的 axe 审计在 Chromium 执行',
  );
  await page.goto('/');
  await page.getByRole('button', { name: '管理员演示', exact: true }).click();
  await expect(page.locator('h1')).toBeVisible();
  const report: any[] = [];
  for (const theme of ['light', 'dark']) {
    if (theme === 'dark')
      await page.getByRole('button', { name: '切换主题' }).click();
    for (const width of [390, 1280]) {
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
        const result = await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
          .analyze();
        report.push({ theme, width, route, violations: result.violations });
      }
    }
  }
  const { writeFile } = await import('node:fs/promises');
  await writeFile('docs/AXE_REPORT.json', JSON.stringify(report, null, 2));
  expect(
    report
      .flatMap((r) => r.violations)
      .map((v) => ({
        id: v.id,
        impact: v.impact,
        nodes: v.nodes.map((n: any) => n.target),
      })),
  ).toEqual([]);
});
