import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium, webkit, devices } from '@playwright/test';
const directory = 'docs/evidence/production';
await mkdir(directory, { recursive: true });
const ready = await fetch('https://fafa888.uk/api/ready');
assert.equal(ready.status, 200);
assert.equal((await ready.json()).status, 'ready');
assert.equal((await fetch('https://fafa888.uk/api/me')).status, 401);
const config = await (await fetch('https://fafa888.uk/auth/config')).json();
assert.equal(config.mock, false);
assert.equal(config.demo, false);
assert.equal(config.google, true);
const screenshots: string[] = [];
for (const [name, engine, options] of [
  ['pc', chromium, { viewport: { width: 1440, height: 1000 } }],
  ['iphone-simulation', webkit, { ...devices['iPhone 13'] }],
] as const) {
  const browser = await engine.launch();
  try {
    const context = await browser.newContext(options);
    for (const [label, url] of [
      ['web', 'https://fafa888.uk'],
      ['admin', 'https://a.fafa888.uk'],
    ]) {
      const page = await context.newPage();
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      page.on('console', (message) => {
        if (
          /Mixed Content|CORS policy|Content Security Policy/i.test(
            message.text(),
          )
        )
          errors.push(message.text());
      });
      await page.goto(url, { waitUntil: 'networkidle' });
      // The Google sign-in link text differs by surface: the member portal
      // renders "使用 Google 登录" (the "G" mark is aria-hidden), while the
      // admin login card renders "G · 使用 Google 登录". Matching the shared
      // substring covers both without weakening the check (a Google sign-in
      // link must still be present and visible).
      // The web login page transiently renders a second, disabled Google
      // link in the left card while /auth/config loads, then removes it;
      // pin to the last match so the wait targets the stable link instead
      // of the transient one.
      await page
        .getByRole('link', { name: '使用 Google 登录' })
        .last.waitFor();
      assert.equal(
        await page
          .getByRole('button', { name: '管理员演示', exact: true })
          .count(),
        0,
      );
      assert(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      );
      assert.deepEqual(errors, []);
      const file = directory + '/' + name + '-' + label + '.png';
      await page.screenshot({ path: file, fullPage: true });
      screenshots.push(file);
      await page.close();
    }
    await context.close();
  } finally {
    await browser.close();
  }
}
await writeFile(
  directory + '/public-checks.json',
  JSON.stringify(
    {
      verifiedAt: new Date().toISOString(),
      commit: process.env.GITHUB_SHA,
      scope: 'Public HTTPS/login pages only; iPhone is WebKit simulation',
      ready: ready.status,
      demonstrationLogin: false,
      screenshots,
      googleLogin: 'NOT_TESTED',
      ownerBinding: 'NOT_TESTED',
      authenticatedSubscription: 'NOT_TESTED',
      ssh: 'NOT_TESTED',
    },
    null,
    2,
  ) + '\n',
);
