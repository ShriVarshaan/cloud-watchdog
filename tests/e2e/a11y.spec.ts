import AxeBuilder from '@axe-core/playwright'
import type { ElectronApplication, Page } from '@playwright/test'
import { expect, test } from './fixtures'

// axe-core over every screen, in light and dark mode (M13). Any serious or
// critical WCAG 2.2 AA violation fails the test. SCREENSHOT_DIR, when set,
// also saves each screen for review.

const shots = process.env['SCREENSHOT_DIR']

async function audit(page: Page, name: string) {
  if (shots) await page.screenshot({ path: `${shots}/a11y-${name}.png` })
  // Legacy mode runs inside this page; the default opens a second page, which Electron does not allow.
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).setLegacyMode(true).analyze()
  const blocking = results.violations
    .filter((violation) => violation.impact === 'serious' || violation.impact === 'critical')
    .map((violation) => `${violation.id}: ${violation.nodes.map((node) => node.target.join(' ')).join(', ')}`)
  expect(blocking, name).toEqual([])
}

/** Reloads the window as the tray popover. Done by the main process, as the app does. */
async function showPopover(app: ElectronApplication, page: Page) {
  await app.evaluate(async ({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0]!
    const url = new URL(win.webContents.getURL())
    url.searchParams.set('view', 'popover')
    await win.loadURL(url.toString())
  })
  await page.setViewportSize({ width: 360, height: 600 })
}

test.describe('accessibility', () => {
  test.use({ fakeAws: 'demo' })

  for (const scheme of ['light', 'dark'] as const) {
    test(`no serious issues on any screen in ${scheme} mode`, async ({ app, mainWindow }) => {
      await mainWindow.emulateMedia({ colorScheme: scheme })
      await mainWindow.setViewportSize({ width: 1180, height: 760 })

      await expect(mainWindow.getByRole('heading', { name: 'Choose the AWS account to watch' })).toBeVisible()
      await audit(mainWindow, `${scheme}-first-run`)

      await mainWindow.getByRole('button', { name: 'Use this profile' }).click()
      await expect(mainWindow.locator('tbody tr')).toHaveCount(7, { timeout: 20_000 })
      await audit(mainWindow, `${scheme}-resources`)

      await mainWindow.getByRole('button', { name: /demo-nat/ }).click()
      await expect(mainWindow.getByRole('complementary')).toBeVisible()
      await audit(mainWindow, `${scheme}-detail`)

      await mainWindow.getByRole('tab', { name: /Scan problems/i }).click()
      await audit(mainWindow, `${scheme}-problems`)

      await mainWindow.getByRole('tab', { name: 'Settings' }).click()
      await expect(mainWindow.getByRole('heading', { name: 'Scanning and alerts' })).toBeVisible()
      await audit(mainWindow, `${scheme}-settings`)

      await showPopover(app, mainWindow)
      await mainWindow.emulateMedia({ colorScheme: scheme })
      await expect(mainWindow.getByRole('meter')).toBeVisible()
      await audit(mainWindow, `${scheme}-popover`)
    })
  }
})
