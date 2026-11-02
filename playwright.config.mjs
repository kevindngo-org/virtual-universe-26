import { defineConfig, devices } from '@playwright/test';

const port = Number(process.env.DOCS_PORT || 8000);

export default defineConfig({
  testDir: './tests/browser',
  testMatch: '**/*.spec.mjs',
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? 'list' : [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: `http://127.0.0.1:${port}`,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `node tests/browser/serve-docs.mjs ${port}`,
    url: `http://127.0.0.1:${port}/`,
    reuseExistingServer: !process.env.CI,
  },
});
