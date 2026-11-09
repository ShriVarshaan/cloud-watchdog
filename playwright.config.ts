import { defineConfig } from '@playwright/test'

// End-to-end tests launch the built Electron app (`npm run test:e2e` builds first).
export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  workers: 1,
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    trace: 'retain-on-failure'
  }
})
