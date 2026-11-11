import type { Page } from '@playwright/test'
import { expect, test } from './fixtures'

// Stopping an instance, against the fake AWS account. The two confirmations
// are native dialogs, which a test cannot click; the app answers them itself
// when WATCHDOG_FAKE_CONFIRM is set, and only with the fake account.

const shots = process.env['SCREENSHOT_DIR']
async function shot(page: Page, name: string) {
  if (shots) await page.screenshot({ path: `${shots}/${name}.png`, fullPage: true })
}

async function connect(page: Page) {
  await page.setViewportSize({ width: 1180, height: 760 })
  await page.getByRole('button', { name: 'Use this profile' }).click()
  await expect(page.locator('tbody tr')).toHaveCount(7, { timeout: 20_000 })
}

async function switchOn(page: Page) {
  await page.getByRole('tab', { name: 'Settings' }).click()
  await page.getByRole('button', { name: 'Switch on stopping' }).click()
}

async function openResource(page: Page, name: RegExp) {
  await page.getByRole('tab', { name: /Resources/ }).click()
  await page.getByRole('button', { name }).click()
  return page.getByRole('complementary')
}

test.describe('stopping, when the user agrees to the confirmations', () => {
  test.use({ fakeAws: 'demo', fakeConfirm: 'yes' })

  test('there is no Stop button until stopping is switched on in Settings', async ({ mainWindow }) => {
    await connect(mainWindow)
    const detail = await openResource(mainWindow, /hackathon-api/)
    await expect(detail.getByRole('button', { name: 'Open in the AWS console' })).toBeVisible()
    await expect(detail.getByRole('button', { name: /Stop/ })).toHaveCount(0)

    await mainWindow.getByRole('tab', { name: 'Settings' }).click()
    await expect(mainWindow.getByText('Off. Cloud Watchdog only looks at your account and changes nothing in it.')).toBeVisible()
    await shot(mainWindow, '7-stopping-off')
  })

  test('switching it on, then stopping a running instance', async ({ mainWindow }) => {
    await connect(mainWindow)
    await switchOn(mainWindow)
    await expect(mainWindow.getByText(/^On for the profile demo\./)).toBeVisible()
    await shot(mainWindow, '8-stopping-on')

    const detail = await openResource(mainWindow, /hackathon-api/)
    await detail.getByRole('button', { name: 'Stop this instance' }).click()
    await expect(detail.getByText('AWS says it is running. If you stop it:')).toBeVisible()
    await expect(detail.getByText('Its disks (EBS volumes) keep billing while it is stopped.')).toBeVisible()
    await shot(mainWindow, '9-stop-preview')

    await detail.getByRole('button', { name: 'Stop instance' }).click()
    await expect(detail.getByRole('status').filter({ hasText: 'AWS is stopping the instance.' })).toBeVisible()
    // The scan that follows shows the new state, and there is nothing left to stop.
    await expect(detail.getByText('eu-west-1, stopped')).toBeVisible({ timeout: 20_000 })
    await expect(detail.getByRole('button', { name: /Stop/ })).toHaveCount(0)
    await shot(mainWindow, '10-stopped')
  })

  test('an instance that must not be stopped gets the reasons, and no way to go on', async ({ mainWindow }) => {
    await connect(mainWindow)
    await switchOn(mainWindow)
    const detail = await openResource(mainWindow, /model-training/)
    await detail.getByRole('button', { name: 'Stop this instance' }).click()

    await expect(detail.getByText('Cloud Watchdog will not stop this:')).toBeVisible()
    await expect(detail.getByText(/instance-store disks/)).toBeVisible()
    await expect(detail.getByRole('button', { name: 'Stop instance' })).toHaveCount(0)
    // The manual way is still there.
    await expect(detail.getByText(/aws ec2 stop-instances/)).toBeVisible()
    await shot(mainWindow, '11-stop-blocked')
  })

  test('things that cannot be stopped at all have no Stop button', async ({ mainWindow }) => {
    await connect(mainWindow)
    await switchOn(mainWindow)
    for (const name of [/demo-nat/, /old-prototype/]) {
      const detail = await openResource(mainWindow, name)
      await expect(detail.getByRole('button', { name: 'Open in the AWS console' })).toBeVisible()
      await expect(detail.getByRole('button', { name: /Stop/ })).toHaveCount(0)
    }
  })

  test('the page cannot switch stopping on through the settings call', async ({ mainWindow }) => {
    await connect(mainWindow)
    const result = await mainWindow.evaluate(async () => {
      const watchdog = (globalThis as unknown as { watchdog: Record<string, (input?: unknown) => Promise<{ ok: boolean }>> }).watchdog
      return watchdog['updateSettings']!({ actionsEnabled: true })
    })
    expect(result).toMatchObject({ ok: false, error: { code: 'invalid-input' } })
  })
})

test.describe('stopping, when the user says no', () => {
  test.use({ fakeAws: 'demo', fakeConfirm: 'no' })

  test('stopping stays off', async ({ mainWindow }) => {
    await connect(mainWindow)
    await switchOn(mainWindow)
    await expect(mainWindow.getByText('Cancelled. Stopping stays switched off.')).toBeVisible()
    await expect(mainWindow.getByText('Off. Cloud Watchdog only looks at your account and changes nothing in it.')).toBeVisible()
  })
})
