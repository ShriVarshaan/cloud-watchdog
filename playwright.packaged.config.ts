import { defineConfig } from '@playwright/test'

// Smoke test of the packaged app (`npm run test:packaged` packages first).
// Separate from the e2e tests, which drive the unpackaged build.
export default defineConfig({
  testDir: './tests/packaged',
  timeout: 60_000,
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: 'list'
})
