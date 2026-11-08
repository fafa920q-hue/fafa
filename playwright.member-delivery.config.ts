import { defineConfig } from '@playwright/test';
import base from './playwright.config';
export default defineConfig({
  ...base,
  testDir: './tests/member-browser',
  reporter: [
    ['list'],
    ['html', { open: 'never', outputFolder: 'member-browser-report' }],
    [
      'json',
      {
        outputFile:
          process.env.FAFA_TEST_REPORT ||
          'docs/evidence/member-delivery-browser.json',
      },
    ],
  ],
  projects: base.projects!.filter((project) =>
    ['chromium', 'iphone', 'android'].includes(project.name!),
  ),
});
