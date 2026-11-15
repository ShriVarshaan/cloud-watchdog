import AxeBuilder from '@axe-core/playwright'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, test } from './fixtures'

// The welcome screen on a computer with no AWS profile: the steps to set one
// up. The AWS config files point at files that do not exist, so the real
// profiles on the machine running the tests are not seen.

const nowhere = join(tmpdir(), 'cloud-watchdog-e2e-no-such-folder')

test.describe('the welcome screen with no AWS profile', () => {
  test.use({
    extraEnv: { AWS_CONFIG_FILE: join(nowhere, 'config'), AWS_SHARED_CREDENTIALS_FILE: join(nowhere, 'credentials') }
  })

  test('shows the steps to set up access, with the CLI checked', async ({ mainWindow }) => {
    await mainWindow.setViewportSize({ width: 1180, height: 760 })
    await expect(mainWindow.getByRole('heading', { name: 'Set up access to your AWS account' })).toBeVisible()

    const steps = mainWindow.locator('.setup-steps > li')
    await expect(steps).toHaveCount(3)
    // Whether this machine has the CLI or not, the first step gives an answer, not "Checking".
    await expect(steps.first()).toContainText(/Done: .*AWS CLI.* installed\.|The AWS CLI is not installed on this computer\./)
    await expect(mainWindow.getByLabel('Command to create a profile with an access key')).toHaveText('aws configure')
    await expect(mainWindow.getByLabel('Command to create a single sign-on profile')).toHaveText('aws configure sso')

    await mainWindow.getByRole('button', { name: 'Check Again' }).click()
    await expect(mainWindow.getByRole('button', { name: 'Check Again' })).toBeEnabled()
    await expect(mainWindow.getByRole('heading', { name: 'Set up access to your AWS account' })).toBeVisible()
  })

  for (const scheme of ['light', 'dark'] as const) {
    test(`has no serious accessibility issues in ${scheme} mode`, async ({ mainWindow }) => {
      await mainWindow.emulateMedia({ colorScheme: scheme })
      await mainWindow.setViewportSize({ width: 1180, height: 760 })
      await expect(mainWindow.locator('.setup-steps > li').first()).not.toContainText('Checking')
      const results = await new AxeBuilder({ page: mainWindow })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
        .setLegacyMode(true)
        .analyze()
      const blocking = results.violations.filter((violation) => violation.impact === 'serious' || violation.impact === 'critical').map((v) => v.id)
      expect(blocking).toEqual([])
      if (process.env['SCREENSHOT_DIR']) await mainWindow.screenshot({ path: `${process.env['SCREENSHOT_DIR']}/setup-${scheme}.png`, fullPage: true })
    })
  }
})
