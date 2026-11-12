import { defineConfig } from '@playwright/test'

// Takes the README screenshots (`npm run screenshots`). Not a test suite.
export default defineConfig({
  testDir: './tests/screenshots',
  timeout: 60_000,
  workers: 1,
  reporter: 'list'
})
