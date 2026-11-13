import { chromium } from '@playwright/test';
import lighthouse from 'lighthouse';
import { mkdir, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const profile = await mkdtemp(join(tmpdir(), 'fafa-lighthouse-'));
const context = await chromium.launchPersistentContext(profile, {
  headless: true,
  args: ['--remote-debugging-port=9222', '--no-sandbox'],
});
try {
  const page = context.pages()[0];
  await page.goto('http://localhost:5173');
  await page.getByRole('button', { name: '管理员演示', exact: true }).click();
  await page.locator('h1').waitFor();
  await page.waitForLoadState('networkidle');
  const r = await lighthouse(
    process.env.PERFORMANCE_URL || 'http://localhost:5173/',
    {
      port: 9222,
      output: ['html', 'json'],
      onlyCategories: ['performance', 'accessibility', 'best-practices'],
      disableStorageReset: true,
      formFactor: 'mobile',
      screenEmulation: {
        mobile: true,
        width: 390,
        height: 844,
        deviceScaleFactor: 1,
        disabled: false,
      },
      throttlingMethod: 'simulate',
    },
  );
  if (!r) throw Error('未生成报告');
  await mkdir('docs/performance', { recursive: true });
  const reports = r.report as string[];
  await writeFile('docs/performance/lighthouse.html', reports[0]);
  await writeFile('docs/performance/lighthouse.json', reports[1]);
  console.log(
    JSON.stringify({
      environment: process.env.PERFORMANCE_URL
        ? '本地生产构建/演示'
        : '本地开发/演示',
      scores: Object.fromEntries(
        Object.entries(r.lhr.categories).map(([k, v]) => [k, v.score]),
      ),
      LCP: r.lhr.audits['largest-contentful-paint'].numericValue,
      CLS: r.lhr.audits['cumulative-layout-shift'].numericValue,
      TBT: r.lhr.audits['total-blocking-time'].numericValue,
    }),
  );
} finally {
  await context.close();
  await rm(profile, { recursive: true, force: true });
}
