import { test, expect } from '@playwright/test';
test('节点批量预览、加密导入、标签编辑及启停删除', async ({ page }) => {
  const batch = '浏览器导入fixture-' + Date.now();
  await page.goto('/');
  await page.getByRole('button', { name: '管理员演示', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: '欢迎使用 FAFA ONE 控制面板 👋' }),
  ).toBeVisible();
  await page.goto('/subscriptions');
  await page.getByRole('button', { name: '批量导入', exact: true }).click();
  await page.getByLabel('节点批次名称').fill(batch);
  await page
    .getByLabel('节点配置（敏感）')
    .fill(
      'ss://' +
        btoa('aes-256-gcm:fictional-browser-fixture') +
        '@node.example.com:8388#' +
        encodeURIComponent('日本 IEPL 测试'),
    );
  await page.getByLabel('我有权使用并聚合这些节点').check();
  await page.getByRole('button', { name: '预览并验证', exact: true }).click();
  await expect(
    page.getByText('有效 1 · 重复 0 · 解析失败 0 · 所有有效节点待验证'),
  ).toBeVisible();
  await expect(page.locator('body')).not.toContainText(
    'fictional-browser-fixture',
  );
  await page
    .getByRole('button', { name: '确认授权并加密导入', exact: true })
    .click();
  const card = page.locator('.resource-card').filter({
    has: page.getByRole('heading', { name: '日本 IEPL 测试', exact: true }),
  });
  await expect(card).toBeVisible();
  await card.getByRole('button', { name: '停用', exact: true }).click();
  await expect(card).toContainText('已禁用');
  await card.getByRole('button', { name: '启用', exact: true }).click();
  await expect(card).toContainText('待真实验证');
  await card
    .getByRole('button', { name: '编辑标签 / 分组', exact: true })
    .click();
  await page.getByLabel('节点名称').fill('日本 IEPL 编辑fixture');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  const edited = page.locator('.resource-card').filter({
    has: page.getByRole('heading', {
      name: '日本 IEPL 编辑fixture',
      exact: true,
    }),
  });
  await expect(edited).toBeVisible();
  page.once('dialog', (dialog) => dialog.accept());
  await edited.getByRole('button', { name: '删除节点', exact: true }).click();
  await expect(edited).toHaveCount(0);
  const cleanup = await page.evaluate(async (name) => {
    const me = await (await fetch('/api/me')).json();
    const sources = await (await fetch('/api/node_sources')).json();
    const source = sources.find((item: any) => item.name === name);
    if (!source) return false;
    return (
      await fetch('/api/node_sources/' + source.id, {
        method: 'DELETE',
        headers: { 'x-csrf-token': me.csrf },
      })
    ).ok;
  }, batch);
  expect(cleanup).toBe(true);
});
