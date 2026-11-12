import type { ElectronApplication, Page } from '@playwright/test'
import { expect, test } from '../e2e/fixtures'

// Takes the README's screenshots from the pretend AWS account, at the
// windows' real sizes, in light and dark mode:
//
//   npm run screenshots        (writes docs/screenshots/*.png)
//
// Page screenshots: they show the page, not the Windows frame or the Mica
// material behind the sidebar. Not part of npm run test:e2e.

const OUT_DIR = 'docs/screenshots'
const MAIN = { width: 1280, height: 780 } // windows.ts
const POPOVER = { width: 360, height: 600 } // windows.ts

/** Reloads the window as the tray popover, as the a11y test does. */
async function showPopover(app: ElectronApplication, page: Page) {
  await app.evaluate(async ({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0]!
    const url = new URL(win.webContents.getURL())
    url.searchParams.set('view', 'popover')
    await win.loadURL(url.toString())
  })
  await page.setViewportSize(POPOVER)
}

test.describe('README screenshots', () => {
  test.use({ fakeAws: 'demo' })

  for (const scheme of ['light', 'dark'] as const) {
    test(`${scheme} mode`, async ({ app, mainWindow }) => {
      await mainWindow.emulateMedia({ colorScheme: scheme })
      await mainWindow.setViewportSize(MAIN)

      await mainWindow.getByRole('button', { name: 'Use this profile' }).click()
      await expect(mainWindow.locator('tbody tr')).toHaveCount(7, { timeout: 20_000 })
      await mainWindow.getByRole('button', { name: /demo-nat/ }).click()
      await expect(mainWindow.getByRole('complementary')).toBeVisible()
      await mainWindow.mouse.move(0, 0) // no hover highlight in the picture
      await mainWindow.screenshot({ path: `${OUT_DIR}/main-window-${scheme}.png` })

      await showPopover(app, mainWindow)
      await mainWindow.emulateMedia({ colorScheme: scheme })
      await expect(mainWindow.getByRole('meter')).toBeVisible()
      await mainWindow.screenshot({ path: `${OUT_DIR}/popover-${scheme}.png` })
    })
  }
})
