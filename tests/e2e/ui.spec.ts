import type { ElectronApplication, Page } from '@playwright/test'
import { expect, test } from './fixtures'

// The UI against the fake AWS account. SCREENSHOT_DIR, when set, saves a
// picture of each screen for review; the tests do not compare pictures.

const shots = process.env['SCREENSHOT_DIR']
async function shot(page: Page, name: string) {
  if (shots) await page.screenshot({ path: `${shots}/${name}.png`, fullPage: true })
}

/** Chooses the demo profile through the first-run screen and waits for the first scan. */
async function connect(page: Page) {
  await expect(page.getByRole('heading', { name: 'Choose the AWS account to watch' })).toBeVisible()
  await shot(page, '1-first-run')
  await page.getByRole('button', { name: 'Use this profile' }).click()
  await expect(page.locator('tbody tr')).toHaveCount(7, { timeout: 20_000 })
}

/** Reloads the window as the tray popover. Done by the main process, as the app does. */
async function showPopover(app: ElectronApplication, page: Page) {
  await app.evaluate(async ({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0]!
    const url = new URL(win.webContents.getURL())
    url.searchParams.set('view', 'popover')
    await win.loadURL(url.toString())
  })
  await page.setViewportSize({ width: 360, height: 480 })
}

test.describe('the UI with the demo account', () => {
  test.use({ fakeAws: 'demo' })

  test('first run, then the summary and the resource list', async ({ mainWindow }) => {
    await mainWindow.setViewportSize({ width: 1180, height: 760 })
    await connect(mainWindow)

    await expect(mainWindow.getByText('Account 111122223333')).toBeVisible()
    const summary = mainWindow.getByRole('region', { name: 'Summary' })
    await expect(summary.getByText('$0.66/h', { exact: true })).toBeVisible()
    await expect(summary.getByRole('meter')).toBeVisible()
    await expect(mainWindow.getByRole('tab', { name: 'Resources (7)' })).toHaveAttribute('aria-selected', 'true')
    // The account-wide runway warning.
    await expect(mainWindow.getByText(/Credits or the plan run out in/)).toBeVisible()
    await shot(mainWindow, '2-resources')
  })

  test('the detail panel explains a resource and gives the command to stop its cost', async ({ mainWindow }) => {
    await mainWindow.setViewportSize({ width: 1180, height: 760 })
    await connect(mainWindow)

    await mainWindow.getByRole('button', { name: /demo-nat/ }).click()
    const detail = mainWindow.getByRole('complementary')
    await expect(detail.getByRole('heading', { name: 'demo-nat' })).toBeVisible()
    await expect(detail.getByText(/Lets servers in a private subnet reach the internet/)).toBeVisible()
    await expect(detail.getByText('Data processed, per GB')).toBeVisible()
    await expect(detail.getByText('aws ec2 delete-nat-gateway --nat-gateway-id nat-0demo000000000001 --region eu-west-1 --profile demo')).toBeVisible()

    await detail.getByRole('button', { name: 'Copy command' }).click()
    await expect(detail.getByRole('status').filter({ hasText: 'Copied' })).toBeVisible()
    await shot(mainWindow, '3-detail')
  })

  test('the table works from the keyboard', async ({ mainWindow }) => {
    await connect(mainWindow)

    const rowButtons = mainWindow.locator('tbody .row-button')
    await rowButtons.first().focus()
    await mainWindow.keyboard.press('Enter')
    await expect(mainWindow.locator('tbody tr').first()).toHaveAttribute('aria-selected', 'true')

    await mainWindow.keyboard.press('ArrowDown')
    await expect(rowButtons.nth(1)).toBeFocused()
    await expect(mainWindow.locator('tbody tr').nth(1)).toHaveAttribute('aria-selected', 'true')

    // Sorting by name from the keyboard.
    await mainWindow.getByRole('button', { name: 'Resource' }).focus()
    await mainWindow.keyboard.press('Enter')
    await expect(mainWindow.getByRole('columnheader', { name: 'Resource' })).toHaveAttribute('aria-sort', /ascending|descending/)
  })

  test('the tabs work from the keyboard', async ({ mainWindow }) => {
    await connect(mainWindow)
    await mainWindow.getByRole('tab', { name: /Resources/ }).focus()
    await mainWindow.keyboard.press('ArrowRight')
    await expect(mainWindow.getByRole('tab', { name: /Scan problems/i })).toBeFocused()
    await expect(mainWindow.getByText('Every part of the last scan worked.')).toBeVisible()
    await mainWindow.keyboard.press('ArrowRight')
    await expect(mainWindow.getByRole('heading', { name: 'Scanning and alerts' })).toBeVisible()
    await shot(mainWindow, '4-settings')
  })

  test('filtering narrows the list', async ({ mainWindow }) => {
    await connect(mainWindow)
    await mainWindow.getByRole('combobox', { name: 'Kind of resource' }).selectOption({ label: 'EBS volume' })
    await expect(mainWindow.locator('tbody tr')).toHaveCount(2)
    await mainWindow.getByRole('searchbox', { name: 'Search resources' }).fill('spare')
    await expect(mainWindow.locator('tbody tr')).toHaveCount(1)
  })

  test('the popover shows the burn rate, the runway and the top warnings', async ({ app, mainWindow }) => {
    await connect(mainWindow)
    await showPopover(app, mainWindow)

    await expect(mainWindow.getByText('$0.66/h', { exact: true })).toBeVisible()
    await expect(mainWindow.getByRole('meter')).toBeVisible()
    await expect(mainWindow.getByRole('heading', { name: 'Warnings' })).toBeVisible()
    await expect(mainWindow.locator('.flag-list li')).toHaveCount(3)
    await expect(mainWindow.getByRole('button', { name: 'Scan now' })).toBeEnabled()
    await shot(mainWindow, '5-popover')
  })
})

test.describe('the UI when the Free Tier API is denied', () => {
  test.use({ fakeAws: 'freetier-denied' })

  test('shows the degraded banner and still lists resources', async ({ mainWindow }) => {
    await mainWindow.setViewportSize({ width: 1180, height: 760 })
    await connect(mainWindow)
    await expect(mainWindow.getByText('Plan details unavailable for this account. Showing resources only.').first()).toBeVisible()
    await expect(mainWindow.getByRole('tab', { name: 'Scan problems (1)' })).toBeVisible()
    await shot(mainWindow, '6-degraded')
  })
})
