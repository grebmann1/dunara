import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/e2e', workers: 1, fullyParallel: false,
  timeout: 300_000, expect: { timeout: 20_000 },
  reporter: [['list']], outputDir: 'test-results',
  snapshotPathTemplate: '{testDir}/../visual/{arg}{ext}',
  use: { browserName: 'chromium', viewport: { width: 1440, height: 1100 }, reducedMotion: 'reduce', trace: 'retain-on-failure', screenshot: 'only-on-failure' },
});
