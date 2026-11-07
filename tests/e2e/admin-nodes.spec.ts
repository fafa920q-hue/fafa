import { test, expect, type Page } from '@playwright/test';

const adminOrigin = 'http://localhost:5174';
const memberId = '22222222-2222-4222-8222-222222222222';

// Browser requests use the real dev proxy, session cookie and CSRF protection.
async function api(page: Page, path: string, method = 'GET', body?: unknown) {
  return page.evaluate(
    async ({ path, method, body }) => {
      const me = await (await fetch('/api/me')).json();
      const response = await fetch(path, {
        method,
        headers: {
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          'x-csrf-token': me.csrf,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, data: await response.json() };
    },
    { path, method, body },
  );
}

test('Owner 节点管理与权限隔离', async ({ page, browser }, testInfo) => {
  const suffix = testInfo.project.name + '-' + Date.now();
  const batch = '后台导入fixture-' + suffix;
  const ssName = '日本 IEPL 1.5x ' + suffix;
  const vmessName = '美国 下载专用 2x ' + suffix;
  const editedName = '日本 IEPL 编辑 ' + suffix;
  const password = 'fictional-admin-ss-' + suffix;
  const uuid = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const ss =
    'ss://' +
    Buffer.from('aes-256-gcm:' + password).toString('base64') +
    '@node.example.com:8388#' +
    encodeURIComponent(ssName);
  const vmess =
    'vmess://' +
    Buffer.from(
      JSON.stringify({
        v: '2',
        ps: vmessName,
        add: 'vmess.node.example.com',
        port: '443',
        id: uuid,
        aid: '0',
        scy: 'auto',
        net: 'ws',
        type: 'none',
        host: 'vmess.node.example.com',
        path: '/synthetic',
        tls: 'tls',
        sni: 'vmess.node.example.com',
      }),
    ).toString('base64');
  let sourceId: string | undefined;
  const memberContext = await browser.newContext();
  try {
    await page.goto(adminOrigin);
    await page.getByRole('button', { name: '管理员演示', exact: true }).click();
    await expect(
      page.getByRole('heading', { name: '管理概览', exact: true }),
    ).toBeVisible();
    await page.goto(adminOrigin + '/sources');
    for (const name of ['新增节点', '批量导入', '新增订阅源'])
      await expect(
        page.getByRole('button', { name, exact: true }),
      ).toBeVisible();

    // No source list or writes are mocked; a real unmatched search shows the CTA.
    await page.getByLabel('搜索订阅源').fill('不存在的来源-' + suffix);
    await page
      .getByRole('button', { name: '从空状态新增订阅源', exact: true })
      .click();
    const sourceDialog = page.getByRole('dialog', {
      name: '新增订阅源',
      exact: true,
    });
    await expect(sourceDialog).toBeVisible();
    await sourceDialog.getByRole('button', { name: '取消', exact: true }).click();
    await page.getByLabel('搜索订阅源').fill('');

    await page.getByRole('button', { name: '批量导入', exact: true }).click();
    const importDialog = page.getByRole('dialog', {
      name: '批量导入节点',
      exact: true,
    });
    await importDialog.getByLabel('节点批次名称').fill(batch);
    await importDialog.getByLabel('节点分组').fill('合成测试分组');
    await importDialog.getByLabel('节点归属').selectOption('THIRD_PARTY_NODE');
    await importDialog
      .getByLabel('节点配置（敏感）')
      .fill([ss, vmess, ss, 'not-a-valid-node'].join('\n'));
    await importDialog
      .getByLabel('第三方聚合、再分发授权依据')
      .fill('仅CI合成节点，无第三方真实服务或凭据');
    await importDialog.getByLabel('我有权使用并聚合这些节点').check();
    await importDialog
      .getByLabel('提供商已允许向获授权用户再分发')
      .check();
    const previewResponse = page.waitForResponse(
      (response) =>
        response.url().endsWith('/api/node-import/preview') &&
        response.request().method() === 'POST',
    );
    await importDialog
      .getByRole('button', { name: '预览并验证', exact: true })
      .click();
    const previewReply = await previewResponse;
    expect(previewReply.status()).toBe(200);
    const preview = await previewReply.json();
    expect(preview.valid).toBe(2);
    expect(preview.duplicates).toBe(1);
    expect(preview.failures).toHaveLength(1);
    for (const sensitive of [password, uuid, ss, vmess])
      expect(JSON.stringify(preview)).not.toContain(sensitive);
    await expect(
      page.getByText('有效 2 · 重复 1 · 解析失败 1 · 所有有效节点待验证'),
    ).toBeVisible();
    await expect(page.locator('body')).not.toContainText(password);
    await expect(page.locator('body')).not.toContainText(uuid);

    const importResponse = page.waitForResponse(
      (response) =>
        response.url().endsWith('/api/node-import') &&
        response.request().method() === 'POST',
    );
    await page
      .getByRole('button', { name: '确认授权并加密导入', exact: true })
      .click();
    const importReply = await importResponse;
    expect(importReply.status()).toBe(200);
    const imported = await importReply.json();
    sourceId = imported.sourceId;
    expect(imported.imported).toBe(2);
    expect(imported.duplicates).toBe(1);
    expect(imported.failures).toHaveLength(1);
    const card = (name: string) =>
      page.locator('.resource-card').filter({
        has: page.getByRole('heading', { name, exact: true }),
      });
    await expect(card(ssName)).toBeVisible();
    await expect(card(vmessName)).toContainText('vmess');
    await expect(card(ssName)).toContainText('IEPL');
    await expect(card(ssName)).toContainText('待真实验证');

    const metadata = await api(page, '/api/nodes');
    expect(metadata.status).toBe(200);
    const importedNodes = metadata.data.filter(
      (node: { sourceId: string }) => node.sourceId === sourceId,
    );
    expect(importedNodes).toHaveLength(2);
    for (const sensitive of [password, uuid, ss, vmess])
      expect(JSON.stringify(metadata.data)).not.toContain(sensitive);

    await card(ssName).getByRole('button', { name: '停用', exact: true }).click();
    await expect(card(ssName)).toContainText('已禁用');
    await card(ssName).getByRole('button', { name: '启用', exact: true }).click();
    await expect(card(ssName)).toContainText('待真实验证');
    await card(ssName)
      .getByRole('button', { name: '编辑标签 / 分组', exact: true })
      .click();
    const editDialog = page.getByRole('dialog', {
      name: '编辑节点标签与分组',
      exact: true,
    });
    await editDialog.getByLabel('节点名称').fill(editedName);
    await editDialog.getByRole('button', { name: '保存', exact: true }).click();
    await expect(card(editedName)).toBeVisible();

    const setGrant = async (operation: 'grant' | 'revoke') => {
      await page
        .getByRole('region', { name: '节点源授权分配', exact: true })
        .locator('.resource-card')
        .filter({
          has: page.getByRole('heading', { name: batch, exact: true }),
        })
        .getByRole('button', { name: '分配 / 撤销授权', exact: true })
        .click();
      const dialog = page.getByRole('dialog', {
        name: '分配 / 撤销资源授权',
        exact: true,
      });
      await dialog.getByLabel('用户').selectOption(memberId);
      await dialog.getByLabel('操作', { exact: true }).selectOption(operation);
      const response = page.waitForResponse(
        (reply) =>
          reply.url().includes('/api/admin/grants') &&
          reply.request().method() ===
            (operation === 'grant' ? 'POST' : 'DELETE'),
      );
      await dialog.getByRole('button', { name: '保存', exact: true }).click();
      expect((await response).status()).toBe(200);
      await expect(dialog).not.toBeVisible();
    };
    await setGrant('grant');
    const grants = await api(page, '/api/admin/grants');
    expect(grants.status).toBe(200);
    expect(grants.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'source',
          resourceId: sourceId,
          userId: memberId,
        }),
      ]),
    );

    const member = await memberContext.newPage();
    await member.goto(adminOrigin);
    await member.getByRole('button', { name: '成员演示', exact: true }).click();
    await expect(
      member.getByRole('heading', { name: '需要管理员权限', exact: true }),
    ).toBeVisible();
    expect((await api(member, '/api/admin/sources')).status).toBe(403);
    const visible = await api(member, '/api/nodes');
    expect(visible.status).toBe(200);
    expect(visible.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: importedNodes[0].id, sourceId }),
      ]),
    );
    expect(
      (await api(member, '/api/nodes/' + importedNodes[0].id, 'PATCH', {
        enabled: false,
      })).status,
    ).toBe(404);
    expect(
      (await api(member, '/api/node_sources/' + sourceId, 'DELETE')).status,
    ).toBe(404);
    await setGrant('revoke');
    const revokedGrants = await api(page, '/api/admin/grants');
    expect(revokedGrants.data).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          resourceId: sourceId,
          userId: memberId,
        }),
      ]),
    );
    const afterRevoke = await api(member, '/api/nodes');
    expect(
      afterRevoke.data.some(
        (node: { sourceId: string }) => node.sourceId === sourceId,
      ),
    ).toBe(false);

    // CI fixture evidence; this is neither a production Owner session nor a real iPhone.
    await page.screenshot({
      path:
        'docs/screenshots/admin-node-management-' +
        testInfo.project.name +
        '.png',
      fullPage: true,
    });

    for (const name of [editedName, vmessName]) {
      page.once('dialog', (dialog) => dialog.accept());
      await card(name)
        .getByRole('button', { name: '删除节点', exact: true })
        .click();
      await expect(card(name)).toHaveCount(0);
    }
    const afterDelete = await api(page, '/api/nodes');
    expect(
      afterDelete.data.some(
        (node: { sourceId: string }) => node.sourceId === sourceId,
      ),
    ).toBe(false);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
  } finally {
    // Only this test's source is removed; seed resources and Owner binding remain.
    try {
      if (sourceId) {
        const cleanup = await api(
          page,
          '/api/node_sources/' + sourceId,
          'DELETE',
        );
        expect(cleanup.status).toBe(200);
      }
    } finally {
      await memberContext.close();
    }
  }
});
