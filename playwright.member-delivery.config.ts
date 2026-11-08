import { defineConfig } from '@playwright/test';
import base from './playwright.config';
export default defineConfig({
  ...base,
  testDir: './tests/member-browser',
  outputDir: process.env.FAFA_TEST_OUTPUT_DIR || 'test-results',
  reporter: [
    ['list'],
    [
      'html',
      {
        open: 'never',
        outputFolder:
          process.env.FAFA_TEST_HTML_REPORT || 'member-browser-report',
      },
    ],
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
