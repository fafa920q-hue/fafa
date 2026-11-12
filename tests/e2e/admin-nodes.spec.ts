import { test, expect, type Page, type TestInfo } from '@playwright/test';

const adminOrigin = 'http://localhost:5174';
const memberId = '22222222-2222-4222-8222-222222222222';

// Assertions use the real dev proxy and the browser context's cookie jar.
// UI mutations still happen through visible controls; HTTP checks verify isolation.
async function api(page: Page, path: string, method = 'GET', body?: unknown) {
  const client = page.context().request;
  const me = await client.get(adminOrigin + '/api/me', { timeout: 5000 });
  expect(me.status()).toBe(200);
  const session = await me.json();
  const response = await client.fetch(adminOrigin + path, {
    method,
    timeout: 5000,
    headers: {
      origin: adminOrigin,
      ...(!['GET', 'HEAD'].includes(method)
        ? { 'x-csrf-token': session.csrf }
        : {}),
    },
    ...(body === undefined ? {} : { data: body }),
  });
  return { status: response.status(), data: await response.json() };
}

async function cleanupSource(
  page: Page,
  id: string,
  info: TestInfo,
  primaryFailure: unknown,
) {
  try {
    const cleanup = await api(page, '/api/node_sources/' + id, 'DELETE');
    expect(cleanup.status).toBe(200);
  } catch (error) {
    if (!primaryFailure) throw error;
    info.annotations.push({
      type: 'cleanup',
      description: 'Source cleanup failed after the primary test failure',
    });
  }
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
  let originalFailure: unknown;
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
    await sourceDialog
      .getByRole('button', { name: '取消', exact: true })
      .click();
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
    await importDialog.getByLabel('提供商已允许向获授权用户再分发').check();
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
    expect(preview.total).toBe(4);
    expect(preview.countries).toEqual({ 日本: 1, 美国: 1 });
    expect(preview.protocols).toEqual({ ss: 1, vmess: 1 });
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

    await card(ssName)
      .getByRole('button', { name: '停用', exact: true })
      .click();
    await expect(card(ssName)).toContainText('已禁用');
    await card(ssName)
      .getByRole('button', { name: '启用', exact: true })
      .click();
    await expect(card(ssName)).toContainText('待真实验证');
    await card(ssName)
      .getByRole('button', { name: '编辑标签 / 分组', exact: true })
      .click();
    const editDialog = page.getByRole('dialog', {
      name: '编辑节点标签与分组',
      exact: true,
    });
    await editDialog.getByLabel('节点名称').fill(editedName);
    await editDialog.getByLabel('标签（每行一个）').fill('IEPL\n下载专用\n2倍');
    await editDialog.getByRole('button', { name: '保存', exact: true }).click();
    await expect(card(editedName)).toBeVisible();
    await expect(card(editedName)).toContainText('下载专用');
    await expect(card(editedName)).toContainText('2倍');

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
      (
        await api(member, '/api/nodes/' + importedNodes[0].id, 'PATCH', {
          enabled: false,
        })
      ).status,
    ).toBe(403);
    expect(
      (await api(member, '/api/node_sources/' + sourceId, 'DELETE')).status,
    ).toBe(403);
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
      fullPage: false,
      scale: 'css',
      animations: 'disabled',
      timeout: 5000,
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
  } catch (error) {
    originalFailure = error;
    throw error;
  } finally {
    // Only this test's source is removed; seed resources and Owner binding remain.
    try {
      if (sourceId)
        await cleanupSource(page, sourceId, testInfo, originalFailure);
    } finally {
      await memberContext.close().catch((error) => {
        if (!originalFailure) throw error;
      });
    }
  }
});

test('Owner 订阅源真实 CRUD', async ({ page }, testInfo) => {
  const name = '源管理fixture-' + testInfo.project.name + '-' + Date.now();
  const editedName = name + '-编辑';
  const password = 'fictional-source-fixture-' + testInfo.project.name;
  const content =
    'ss://' +
    Buffer.from('aes-256-gcm:' + password).toString('base64') +
    '@source.node.example.com:8388#' +
    encodeURIComponent('日本 IEPL 安全来源fixture');
  let sourceId: string | undefined;
  let removed = false;
  let originalFailure: unknown;
  try {
    await page.goto(adminOrigin);
    await page.getByRole('button', { name: '管理员演示', exact: true }).click();
    await expect(
      page.getByRole('heading', { name: '管理概览', exact: true }),
    ).toBeVisible();
    await page.goto(adminOrigin + '/sources');
    await page.getByRole('button', { name: '新增订阅源', exact: true }).click();
    const create = page.getByRole('dialog', {
      name: '新增订阅源',
      exact: true,
    });
    await create.getByLabel('源名称').fill(name);
    await create.getByLabel('源类型').selectOption('OWNED_NODE');
    await create.getByLabel('自有节点配置').fill(content);
    await create.getByLabel('国家 / 地区').fill('日本');
    await create.getByLabel('分组（可选）').fill('初始分组');
    await create.getByLabel('我有权使用并聚合该资源').check();
    const createdResponse = page.waitForResponse(
      (response) =>
        response.url().endsWith('/api/node_sources') &&
        response.request().method() === 'POST',
    );
    await create.getByRole('button', { name: '保存', exact: true }).click();
    const createdReply = await createdResponse;
    expect(createdReply.status()).toBe(200);
    const created = await createdReply.json();
    sourceId = created.id;
    expect(created.nodeCount).toBe(1);
    expect(created.status).toBe('READY');
    for (const sensitive of [password, content])
      expect(JSON.stringify(created)).not.toContain(sensitive);

    const source = (value: string) =>
      page
        .getByRole('region', { name: '我的订阅源', exact: true })
        .locator('.resource-card')
        .filter({
          has: page.getByRole('heading', { name: value, exact: true }),
        });
    await expect(source(name)).toContainText('初始分组');
    const before = await api(page, '/api/nodes');
    const node = before.data.find(
      (item: { sourceId: string }) => item.sourceId === sourceId,
    );
    expect(node).toMatchObject({ protocol: 'ss', country: '日本' });
    await source(name)
      .getByRole('button', { name: '编辑', exact: true })
      .click();
    const edit = page.getByRole('dialog', { name: '编辑订阅源', exact: true });
    await expect(edit.getByLabel('自有节点配置')).toHaveCount(0);
    await expect(edit.getByLabel('第三方订阅 URL')).toHaveCount(0);
    await expect(edit.getByLabel('我有权使用并聚合该资源')).toBeChecked();
    await edit.getByLabel('源名称').fill(editedName);
    await edit.getByLabel('分组（可选）').fill('元数据编辑分组');
    const patchedResponse = page.waitForResponse(
      (response) =>
        response.url().endsWith('/api/node_sources/' + sourceId) &&
        response.request().method() === 'PATCH',
    );
    await edit.getByRole('button', { name: '保存', exact: true }).click();
    const patchedReply = await patchedResponse;
    expect(patchedReply.status()).toBe(200);
    const patch = patchedReply.request().postDataJSON();
    expect(patch).not.toHaveProperty('content');
    expect(patch).not.toHaveProperty('url');
    const patched = await patchedReply.json();
    for (const sensitive of [password, content])
      expect(JSON.stringify(patched)).not.toContain(sensitive);
    await expect(source(editedName)).toContainText('元数据编辑分组');
    const afterEdit = await api(page, '/api/nodes');
    expect(afterEdit.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: node.id, sourceId, protocol: 'ss' }),
      ]),
    );

    for (const enabled of [false, true]) {
      const toggledResponse = page.waitForResponse(
        (response) =>
          response
            .url()
            .endsWith('/api/node_sources/' + sourceId + '/enabled') &&
          response.request().method() === 'PATCH',
      );
      await source(editedName)
        .getByRole('button', { name: enabled ? '启用' : '停用', exact: true })
        .click();
      expect((await toggledResponse).status()).toBe(200);
      await expect(source(editedName)).toContainText(
        enabled ? '已解析 · 待实测' : '已停用',
      );
    }
    const detail = await api(page, '/api/node_sources/' + sourceId);
    expect(detail.status).toBe(200);
    expect(detail.data).toMatchObject({
      name: editedName,
      group: '元数据编辑分组',
      enabled: true,
      nodeCount: 1,
    });
    for (const sensitive of [password, content])
      expect(JSON.stringify(detail.data)).not.toContain(sensitive);
    await expect(page.locator('body')).not.toContainText(password);

    await source(editedName)
      .getByRole('button', { name: '删除', exact: true })
      .click();
    const deletedResponse = page.waitForResponse(
      (response) =>
        response.url().endsWith('/api/node_sources/' + sourceId) &&
        response.request().method() === 'DELETE',
    );
    await page
      .getByRole('dialog', { name: '删除订阅源？', exact: true })
      .getByRole('button', { name: '确认操作', exact: true })
      .click();
    expect((await deletedResponse).status()).toBe(200);
    removed = true;
    await expect(source(editedName)).toHaveCount(0);
    expect((await api(page, '/api/node_sources/' + sourceId)).status).toBe(404);
    const afterDelete = await api(page, '/api/nodes');
    expect(
      afterDelete.data.some(
        (item: { sourceId: string }) => item.sourceId === sourceId,
      ),
    ).toBe(false);
  } catch (error) {
    originalFailure = error;
    throw error;
  } finally {
    if (sourceId && !removed)
      await cleanupSource(page, sourceId, testInfo, originalFailure);
  }
});

// 节点导入布局用例：双主题 × 缩小可视高度（430px），验证导入按钮真实可操作。
// 另在完整高度下断言弹窗不塌缩（iPad Safari 生产缺陷回归，见下方 iPad 用例）。
async function importLayoutCase(
  page: Page,
  testInfo: TestInfo,
  width: number,
  fullHeight = 844,
) {
  await page.goto(adminOrigin);
  await page.getByRole('button', { name: '管理员演示', exact: true }).click();
  await page.getByRole('heading', { name: '管理概览', exact: true }).waitFor();
  await page.goto(adminOrigin + '/sources');
  const content =
    'ss://' +
    Buffer.from('aes-256-gcm:synthetic-layout-only').toString('base64url') +
    '@node.example.com:8388#' +
    encodeURIComponent('日本 IEPL 1.5倍 布局fixture');
  for (const theme of ['light', 'dark']) {
    await page.setViewportSize({ width, height: fullHeight });
    const current = await page.locator('html').getAttribute('data-theme');
    if ((current || 'light') !== theme)
      await page.getByRole('button', { name: '切换主题', exact: true }).click();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    for (const name of ['新增节点', '批量导入', '新增订阅源'])
      await expect(
        page.getByRole('button', { name, exact: true }),
      ).toBeEnabled();
    await expect(
      page.getByRole('button', { name: '刷新节点与订阅源', exact: true }),
    ).toBeEnabled();
    await page.getByRole('button', { name: '批量导入', exact: true }).click();
    const dialog = page.getByRole('dialog', {
      name: '批量导入节点',
      exact: true,
    });
    // iPad Safari 生产缺陷回归：弹窗内容区不得塌缩为仅标题行。
    // 弹窗与内容区高度必须远大于标题行（塌缩时仅约 100px），
    // 表单与提交按钮在完整高度下即可见。
    const dialogBox = await dialog.boundingBox();
    expect(dialogBox).not.toBeNull();
    expect(dialogBox!.height).toBeGreaterThan(300);
    const contentBox = await dialog.locator('.dialog-content').boundingBox();
    expect(contentBox).not.toBeNull();
    expect(contentBox!.height).toBeGreaterThan(300);
    await expect(dialog.getByLabel('节点配置（敏感）')).toBeVisible();
    await expect(
      dialog.getByRole('button', { name: '预览并验证', exact: true }),
    ).toBeVisible();
    await dialog
      .getByLabel('节点批次名称')
      .fill('布局fixture-' + width + '-' + theme);
    await dialog
      .getByLabel('节点配置（敏感）')
      .fill([content, content, 'invalid-layout-fixture'].join('\n'));
    await dialog.getByLabel('我有权使用并聚合这些节点').check();
    // Reduced viewport models limited space only; it is not a real iOS keyboard test.
    await page.setViewportSize({ width, height: 430 });
    const submit = dialog.getByRole('button', {
      name: '预览并验证',
      exact: true,
    });
    const geometry = await submit.evaluate(async (element) => {
      const samples = [];
      for (let sample = 0; sample < 5; sample++) {
        const box = element.getBoundingClientRect();
        const modal = element.closest('dialog');
        const bounds = modal?.getBoundingClientRect();
        samples.push({
          box: { x: box.x, y: box.y, width: box.width, height: box.height },
          viewport: {
            width: innerWidth,
            height: innerHeight,
            visualWidth: visualViewport?.width,
            visualHeight: visualViewport?.height,
            scale: visualViewport?.scale,
            offsetTop: visualViewport?.offsetTop,
          },
          modal: bounds && {
            x: bounds.x,
            y: bounds.y,
            width: bounds.width,
            height: bounds.height,
            scrollTop: modal?.scrollTop,
            scrollHeight: modal?.scrollHeight,
          },
          focusedTag: document.activeElement?.tagName,
          transform: getComputedStyle(element).transform,
        });
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return samples;
    });
    console.log(
      'IMPORT_LAYOUT_GEOMETRY',
      JSON.stringify({
        project: testInfo.project.name,
        width,
        theme,
        samples: geometry,
      }),
    );
    // 按钮已在可视区域内且弹窗内容未溢出（scrollHeight 小于高度），
    // 该调用曾在 CI 中卡在 waiting for element to be stable 直到超时，
    // 而采样证明按钮坐标完全稳定，因此不再强制滚动。
    // 直接验证真实可操作性：可见、可启用、位于视口内，再正常点击；
    // click 自带按需滚动与作用性检查，不用 force。
    await expect(submit).toBeVisible();
    await expect(submit).toBeEnabled();
    const button = await submit.boundingBox();
    expect(button).not.toBeNull();
    expect(button!.y).toBeGreaterThanOrEqual(0);
    expect(button!.y + button!.height).toBeLessThanOrEqual(431);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await submit.click();
    const preview = page.getByRole('dialog', {
      name: '节点导入预览',
      exact: true,
    });
    await expect(
      preview.getByText('原始条目 3', { exact: true }),
    ).toBeVisible();
    await expect(
      preview.getByRole('group', { name: '预览地区统计', exact: true }),
    ).toContainText('日本 1');
    await expect(
      preview.getByRole('group', { name: '预览协议统计', exact: true }),
    ).toContainText('ss 1');
    await expect(
      preview.getByText('有效 1 · 重复 1 · 解析失败 1 · 所有有效节点待验证'),
    ).toBeVisible();
    if (theme === 'dark') {
      // Synthetic CI data and emulated viewports only; no real iPhone claim.
      await preview.screenshot({
        path:
          'docs/screenshots/admin-import-layout-' +
          testInfo.project.name +
          '-' +
          width +
          '.png',
      });
    }
    await preview
      .getByRole('button', { name: '取消并清除待导入内容', exact: true })
      .click();
    await expect(preview).not.toBeVisible();
  }
}

// 真实移动端尺寸与低高度测试保留在全部项目（含 iPhone）运行。
for (const width of [375, 390, 430, 768]) {
  test(
    '节点导入在 ' + width + 'px、双主题和缩小可视高度下可操作',
    async ({ page }, testInfo) => {
      await importLayoutCase(page, testInfo, width);
    },
  );
}

// 1440px 为桌面宽度，仅在桌面项目验证；移动项目跳过。
test.describe('节点导入 1440px 桌面宽度', () => {
  test.skip(({ isMobile }) => isMobile, '1440px 为桌面宽度，仅在桌面项目验证');
  test('节点导入在 1440px、双主题和缩小可视高度下可操作', async ({
    page,
  }, testInfo) => {
    await importLayoutCase(page, testInfo, 1440);
  });
});

// iPad Safari 生产缺陷回归（2026-11-07）：批量导入弹窗在 iPad 真机 Safari
// 上塌缩为仅标题行，表单与提交按钮不可见。本地 Playwright WebKit 复现
// 未重现该塌缩（与真机 Safari 存在引擎差异），本用例锁定 iPad 视口下
// 弹窗的正确几何，防止回归；最终验收仍以真机 iPad Safari 为准。
test.describe('节点导入 iPad 视口', () => {
  for (const [width, height] of [
    [1180, 820],
    [820, 1180],
  ] as const) {
    test(
      '节点导入在 iPad ' + width + 'x' + height + ' 下表单可见可提交',
      async ({ page }, testInfo) => {
        await importLayoutCase(page, testInfo, width, height);
      },
    );
  }
});
