import { test, expect, type Page } from '@playwright/test';
const tile =
  '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="#e7edf6"/><path d="M0 128H256M128 0V256" stroke="#b3bcd4"/><text x="12" y="24" fill="#485673">TEST TILE</text></svg>';
async function tiles(page: Page) {
  await page.route('https://tile.openstreetmap.org/**', (r) =>
    r.fulfill({ contentType: 'image/svg+xml', body: tile }),
  );
}
async function login(page: Page, name = '成员演示') {
  await tiles(page);
  await page.goto('/');
  await page.getByRole('button', { name, exact: true }).click();
  await expect(
    page.getByRole('heading', { name: '欢迎使用 FAFA ONE 控制面板 👋' }),
  ).toBeVisible();
  await page.goto('/locations');
  await expect(
    page.getByRole('region', { name: '全球地图，拖动地图或标记选点' }),
  ).toHaveAttribute('data-ready', 'true');
}
test('map selection, conversion, link parsing, real private favorite API and direct module readback', async ({
  page,
}, info) => {
  await login(page);
  const map = page.getByRole('region', {
    name: '全球地图，拖动地图或标记选点',
  });
  const old = await page.getByTestId('selected-coordinate').innerText();
  await map.click({ position: { x: 120, y: 130 } });
  await expect(page.getByTestId('selected-coordinate')).not.toHaveText(old);
  await expect(
    page.getByRole('button', { name: '拖动标记选点', exact: true }),
  ).toBeVisible();
  const bounds = (await map.boundingBox())!;
  const beforeDrag = await page.getByTestId('selected-coordinate').innerText();
  await page.mouse.move(bounds.x + bounds.width * 0.8, bounds.y + 180);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width * 0.6, bounds.y + 140, {
    steps: 10,
  });
  await page.mouse.up();
  await expect(page.getByTestId('selected-coordinate')).not.toHaveText(beforeDrag);
  await page.getByLabel('输入坐标系', { exact: true }).selectOption('GCJ02');
  await page.getByLabel('纬度', { exact: true }).fill('39.9164043');
  await page.getByLabel('经度', { exact: true }).fill('116.4102445');
  await expect(
    page.getByRole('button', { name: '保存到设备', exact: true }),
  ).toBeDisabled();
  await page.getByRole('button', { name: '应用坐标', exact: true }).click();
  await expect(page.getByTestId('selected-coordinate')).toContainText('39.915');
  await page
    .getByLabel('地图分享链接')
    .fill('https://maps.apple.com/?ll=48.85,2.35');
  await page.getByRole('button', { name: '解析链接', exact: true }).click();
  await expect(page.getByTestId('selected-coordinate')).toContainText(
    '48.850000, 2.350000',
  );
  const label = 'WLOC browser fixture ' + Date.now() + info.project.name;
  await page.getByLabel('地点名称', { exact: true }).fill(label);
  const created = page.waitForResponse(
    (r) =>
      r.url().endsWith('/api/location_presets') &&
      r.request().method() === 'POST',
  );
  await page.getByRole('button', { name: '收藏当前地点' }).click();
  expect((await created).status()).toBe(200);
  await expect(
    page.getByRole('heading', { name: label, exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole('heading', { name: label, exact: true }),
  ).toBeVisible();
  await page
    .getByRole('article')
    .filter({ has: page.getByRole('heading', { name: label, exact: true }) })
    .getByRole('button', { name: '选择地点' })
    .click();
  let stored: any = null;
  const requests: string[] = [];
  await page.route(
    'https://gs-loc.apple.com/wloc-settings/save**',
    async (route) => {
      const req = route.request();
      const url = new URL(req.url());
      requests.push(url.searchParams.get('action') || 'save');
      const headers = await req.allHeaders();
      expect(headers.cookie).toBeUndefined();
      expect(headers.authorization).toBeUndefined();
      expect(headers['x-csrf-token']).toBeUndefined();
      if (!url.searchParams.has('action'))
        stored = {
          success: true,
          latitude: Number(url.searchParams.get('lat')),
          longitude: Number(url.searchParams.get('lon')),
          accuracy: Number(url.searchParams.get('acc')),
          randomRadius: Number(url.searchParams.get('randomRadius')),
        };
      if (url.searchParams.get('action') === 'clear') stored = null;
      const data =
        url.searchParams.get('action') === 'clear'
          ? { success: true }
          : stored || { success: false, error: '无已保存的坐标' };
      await route.fulfill({
        contentType: 'application/json',
        headers: { 'access-control-allow-origin': '*' },
        body: JSON.stringify(data),
      });
    },
  );
  await page.getByRole('button', { name: '保存到设备', exact: true }).click();
  await expect(page.getByTestId('device-status')).toContainText(
    '已保存并回读一致',
  );
  expect(requests).toEqual(['save', 'query']);
  await page.getByRole('button', { name: '清除设备配置', exact: true }).click();
  await page.getByRole('button', { name: '确认清除', exact: true }).click();
  await expect(page.getByTestId('device-status')).toContainText(
    '已清除并回读为空',
  );
  expect(requests.slice(-2)).toEqual(['clear', 'query']);
  // Browser fixtures prove protocol/UI only; not a physical iOS location test.
  await page.screenshot({
    path:
      'docs/screenshots/wloc-protocol-fixture-' + info.project.name + '.png',
    fullPage: true,
    animations: 'disabled',
  });
  page.once('dialog', (d) => d.accept());
  await page
    .getByRole('article')
    .filter({ has: page.getByRole('heading', { name: label, exact: true }) })
    .getByRole('button', { name: '删除收藏' })
    .click();
  await expect(
    page.getByRole('heading', { name: label, exact: true }),
  ).toHaveCount(0);
});
test('search and module failures remain failures, no fake saved status', async ({
  page,
}) => {
  await login(page);
  await page.route('**/api/location-tools/search?**', (r) =>
    r.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        results: [
          { latitude: 48.85, longitude: 2.35, name: 'Paris search fixture' },
        ],
      }),
    }),
  );
  await page.getByLabel('地点搜索').fill('Paris');
  await page.getByRole('button', { name: '搜索地点' }).click();
  await page.getByRole('button', { name: 'Paris search fixture' }).click();
  await expect(page.getByTestId('selected-coordinate')).toContainText(
    '48.850000',
  );
  await page.route('https://gs-loc.apple.com/**', (r) => r.abort('failed'));
  await page.getByRole('button', { name: '查询设备配置', exact: true }).click();
  await expect(page.getByTestId('device-status')).toContainText('查询失败');
  await expect(
    page.getByRole('alert').filter({ hasText: '未获得有效WLOC模块响应' }),
  ).toBeVisible();
  await page.getByRole('button', { name: '保存到设备', exact: true }).click();
  await expect(page.getByTestId('device-status')).toContainText('保存未确认');
  await page.route('**/api/location-tools/search?**', (r) =>
    r.fulfill({
      status: 502,
      contentType: 'application/json',
      body: JSON.stringify({ message: '地点搜索服务暂不可用' }),
    }),
  );
  await page.getByRole('button', { name: '搜索地点' }).click();
  await expect(
    page.getByRole('alert').filter({ hasText: '地点搜索服务暂不可用' }).first(),
  ).toBeVisible();
});
test('375/390/430/768/1440px light and dark layouts keep real controls usable', async ({
  page,
}, info) => {
  await login(page);
  for (const width of [375, 390, 430, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      'layout ' + width,
    ).toBe(true);
    await page.getByLabel('纬度', { exact: true }).fill('48.85');
    await page.getByLabel('经度', { exact: true }).fill('2.35');
    await page.getByRole('button', { name: '应用坐标', exact: true }).click();
    await expect(
      page.getByRole('button', { name: '保存到设备', exact: true }),
    ).toBeEnabled();
    await page.getByRole('button', { name: '切换主题' }).click();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path:
        'docs/screenshots/wloc-' +
        width +
        '-dark-' +
        info.project.name +
        '.png',
      fullPage: true,
      animations: 'disabled',
    });
    await page.getByRole('button', { name: '切换主题' }).click();
  }
});
test('Viewer cannot create platform favorites or write other users data', async ({
  page,
}) => {
  await login(page, '访客演示');
  await expect(page.getByRole('button', { name: '收藏当前地点' })).toHaveCount(
    0,
  );
  const status = await page.evaluate(async () => {
    const me = await (await fetch('/api/me')).json();
    return (
      await fetch('/api/location_presets', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-csrf-token': me.csrf,
        },
        body: JSON.stringify({ name: 'forbidden', latitude: 1, longitude: 2 }),
      })
    ).status;
  });
  expect(status).toBe(403);
});
