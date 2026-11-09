import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, test as base, type ElectronApplication, type Page } from '@playwright/test'

type Fixtures = {
  app: ElectronApplication
  mainWindow: Page
}

// Launches the built app with a throwaway user-data folder, so tests never
// touch a real install's settings or database. No --no-sandbox: the tests
// must see the renderer exactly as users get it.
export const test = base.extend<Fixtures>({
  // eslint-disable-next-line no-empty-pattern
  app: async ({}, use) => {
    const userData = mkdtempSync(join(tmpdir(), 'cloud-watchdog-e2e-'))
    const app = await electron.launch({
      args: ['.'],
      env: { ...process.env, CW_USER_DATA_DIR: userData }
    })
    await use(app)
    await app.close()
    rmSync(userData, { recursive: true, force: true })
  },

  mainWindow: async ({ app }, use) => {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await use(page)
  }
})

export { expect } from '@playwright/test'
