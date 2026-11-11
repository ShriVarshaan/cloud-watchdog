import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, test as base, type ElectronApplication, type Page } from '@playwright/test'

type Fixtures = {
  app: ElectronApplication
  mainWindow: Page
}

type Options = {
  /** WATCHDOG_FAKE_AWS for the launched app: "demo", "freetier-denied", or undefined for none. */
  fakeAws: string | undefined
  /** How the launched app answers its native confirmation dialogs: "yes" or "no". Only works with fakeAws. */
  fakeConfirm: 'yes' | 'no' | undefined
}

// Launches the built app with a throwaway user-data folder, so tests never
// touch a real install's settings or database. No --no-sandbox: the tests
// must see the renderer exactly as users get it.
export const test = base.extend<Fixtures & Options>({
  fakeAws: [undefined, { option: true }],
  fakeConfirm: [undefined, { option: true }],

  app: async ({ fakeAws, fakeConfirm }, use) => {
    const userData = mkdtempSync(join(tmpdir(), 'cloud-watchdog-e2e-'))
    const env: Record<string, string> = { ...(process.env as Record<string, string>), CW_USER_DATA_DIR: userData }
    delete env['WATCHDOG_FAKE_AWS']
    delete env['WATCHDOG_FAKE_CONFIRM']
    if (fakeAws) env['WATCHDOG_FAKE_AWS'] = fakeAws
    if (fakeConfirm) env['WATCHDOG_FAKE_CONFIRM'] = fakeConfirm
    const app = await electron.launch({ args: ['.'], env })
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
