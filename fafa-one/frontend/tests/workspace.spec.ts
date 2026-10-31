import { test, expect, Page } from "@playwright/test";
import fs from "node:fs";

async function login(page: Page) {
  await page.goto("/");
  await page
    .getByLabel("邮箱", { exact: true })
    .fill("browser-admin@example.com");
  await page
    .getByLabel("密码", { exact: true })
    .fill("browser-admin-password-123");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "你好，Super Admin。" }),
  ).toBeVisible();
}
async function noOverflow(page: Page) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
}
for (const width of [375, 768, 1440]) {
  test(`real backend navigation and layout at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await login(page);
    await noOverflow(page);
    await page
      .locator("nav:visible")
      .getByRole("link", { name: "AI", exact: width <= 760 })
      .click();
    await expect(
      page.getByRole("heading", { name: "今天，一起解决什么？" }),
    ).toBeVisible();
    await noOverflow(page);
    await page
      .getByLabel("消息", { exact: true })
      .fill("在没有真实 API 连接时不应发送。");
    await expect(
      page.getByRole("button", { name: "发送", exact: true }),
    ).toBeDisabled();
    await page.getByLabel("消息", { exact: true }).focus();
    await page.setViewportSize({ width, height: 520 });
    const box = await page.getByLabel("消息", { exact: true }).boundingBox();
    expect(box).not.toBeNull();
    expect(box!.y + box!.height).toBeLessThan(520);
    await page.setViewportSize({ width, height: 844 });
    await page
      .locator("nav:visible")
      .getByRole("link", { name: "我的", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "我的 AI 账户" }),
    ).toBeVisible();
    await noOverflow(page);
    await page.screenshot({
      path: `../docs/evidence/workspace-${width}.png`,
      fullPage: true,
    });
    await page.goBack();
    await expect(
      page.getByRole("heading", { name: "今天，一起解决什么？" }),
    ).toBeVisible();
  });
}

test("registration and real connection CRUD without a fabricated provider response", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.getByRole("button", { name: "注册账户", exact: true }).click();
  await page.getByLabel("昵称").fill("Browser member");
  await page
    .getByLabel("邮箱", { exact: true })
    .fill("browser-member@example.com");
  await page
    .getByLabel("密码", { exact: true })
    .fill("browser-member-password-123");
  await page.getByRole("button", { name: "注册", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "登录", exact: true }),
  ).toBeVisible();
  await page
    .getByLabel("邮箱", { exact: true })
    .fill("browser-member@example.com");
  await page
    .getByLabel("密码", { exact: true })
    .fill("browser-member-password-123");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page
    .locator("nav:visible")
    .getByRole("link", { name: "我的", exact: true })
    .click();
  for (const name of ["Personal API A", "Personal API B"]) {
    await page.getByRole("button", { name: "添加连接" }).click();
    const modal = page.getByRole("dialog");
    await expect(modal).toBeVisible();
    await modal.getByLabel("账户备注").fill(name);
    await modal
      .getByLabel("官方 API Key")
      .fill("BROWSER-TEST-NOT-A-REAL-API-KEY");
    await modal.getByRole("button", { name: "保存连接" }).click();
    await expect(modal).not.toBeVisible();
    await expect(
      page.getByRole("heading", { name, exact: false }),
    ).toBeVisible();
  }
  const second = page
    .locator(".connection-row")
    .filter({ hasText: "Personal API B" });
  await second.getByRole("button", { name: "设为默认", exact: true }).click();
  await expect(second.locator(".pill")).toHaveText("默认");
  await expect(page.locator("body")).not.toContainText(
    "BROWSER-TEST-NOT-A-REAL-API-KEY",
  );
  await expect(second).toContainText("待检测");
  // Do not submit a made-up key to an official provider. No network mocking is used.
  await second.getByRole("button", { name: "设置", exact: true }).click();
  const modal = page.getByRole("dialog");
  await modal.getByLabel("账户备注").fill('<script>alert("xss")</script>');
  await modal.getByRole("button", { name: "保存连接", exact: true }).click();
  await expect(modal).not.toBeVisible();
  await expect(
    page.locator(".connection-row").filter({ hasText: "<script>" }),
  ).toBeVisible();
  page.on("dialog", (dialog) => dialog.accept());
  await page
    .locator(".connection-row")
    .filter({ hasText: "<script>" })
    .getByRole("button", { name: "撤销", exact: true })
    .click();
  await expect(
    page.locator(".connection-row").filter({ hasText: "<script>" }),
  ).toContainText("已撤销");
  await page
    .locator(".connection-row")
    .filter({ hasText: "<script>" })
    .getByRole("button", { name: "删除", exact: true })
    .click();
  await expect(
    page.locator(".connection-row").filter({ hasText: "<script>" }),
  ).toHaveCount(0);
  // Assert actual backend RBAC, using this ordinary browser user's actual session.
  const denied = await page.request.get("/api/v1/admin/users");
  expect(denied.status()).toBe(403);
});

test("modal focus, theme and reduced motion", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await login(page);
  await page
    .locator("nav:visible")
    .getByRole("link", { name: "我的", exact: true })
    .click();
  const add = page.getByRole("button", { name: "添加连接" });
  await add.click();
  await expect(page.getByRole("dialog").getByLabel("账户备注")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(add).toBeFocused();
  await page.getByLabel("切换主题").click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
});

test("production-bundle lab performance sample, without a field p75 claim", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => {
    const metrics = { lcp: 0, cls: 0 };
    Object.assign(window, { fafaMetrics: metrics });
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) metrics.lcp = e.startTime;
    }).observe({ type: "largest-contentful-paint", buffered: true });
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        const shift = e as PerformanceEntry & {
          value: number;
          hadRecentInput: boolean;
        };
        if (!shift.hadRecentInput) metrics.cls += shift.value;
      }
    }).observe({ type: "layout-shift", buffered: true });
  });
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "回到你的工作空间" }),
  ).toBeVisible();
  await page.waitForTimeout(500);
  const result = await page.evaluate(() => ({
    ...(window as unknown as { fafaMetrics: { lcp: number; cls: number } })
      .fafaMetrics,
    resources: performance.getEntriesByType("resource").map((r) => ({
      name: new URL(r.name).pathname,
      bytes: (r as PerformanceResourceTiming).transferSize,
    })),
  }));
  fs.writeFileSync(
    "../docs/evidence/performance-lab.json",
    JSON.stringify(
      {
        scope:
          "single local Chromium lab run on production bundle; no network throttle; not field p75; INP unmeasured; not Safari",
        viewport: [390, 844],
        ...result,
      },
      null,
      2,
    ),
  );
  expect(result.cls).toBeLessThanOrEqual(0.1);
});

// Explicitly blocked external acceptance; never replaced with mock successes.
for (const name of [
  "live official AI key check, model switch and generation",
  "Codex authorized device, approval, execution and diff",
  "Claude Code authorized device and task continuation",
  "production node entitlement and client subscription import",
  "GitHub collection, editorial approval and bookmark",
  "academy draft, review, publication and reading progress",
  "real Google OAuth sign in",
  "official WeChat and QQ website sign in",
  "administrator MFA login on a.fafa888.uk",
  "production migration and verified rollback",
  "real iPhone Safari keyboard and PWA lifecycle",
  "Firefox, macOS Safari and Windows Edge acceptance",
])
  test.skip(name, async () => {
    /* Missing credentials, implementation or target device; see release gates. */
  });
