import { expect, test } from './fixtures'

// A whole scan in the built app, against the fake AWS account (fakeAws.ts):
// choose the profile, the main process scans, prices, flags and saves, and the
// result reaches the window through the preload bridge.

type Result<T = unknown> = { ok: boolean; value?: T; error?: { code: string; message: string } }
type Bridge = Record<string, (input?: unknown) => Promise<Result>> & {
  onStateChanged(listener: (state: unknown) => void): () => void
}

test.describe('scan with the fake AWS account', () => {
  test.use({ fakeAws: 'demo' })

  test('choosing the profile scans and the result reaches the window', async ({ mainWindow }) => {
    // Listen for state:changed before anything happens.
    await mainWindow.evaluate(() => {
      const w = globalThis as unknown as { watchdog: Bridge; seenStates: unknown[] }
      w.seenStates = []
      w.watchdog.onStateChanged((state) => w.seenStates.push(state))
    })

    const profiles = await mainWindow.evaluate(() => (globalThis as unknown as { watchdog: Bridge }).watchdog['listProfiles']!())
    expect(profiles).toEqual({ ok: true, value: ['demo'] })

    const selected = await mainWindow.evaluate(() =>
      (globalThis as unknown as { watchdog: Bridge }).watchdog['selectProfile']!({ profile: 'demo' })
    )
    expect(selected).toMatchObject({ ok: true, value: { accountId: '111122223333', profile: 'demo' } })

    await expect
      .poll(async () => {
        const state = await mainWindow.evaluate(() => (globalThis as unknown as { watchdog: Bridge }).watchdog['getState']!())
        return (state.value as { lastScan: { resourceCount: number } | null }).lastScan?.resourceCount ?? null
      }, { timeout: 15_000 })
      .toBe(7)

    const latest = (await mainWindow.evaluate(() =>
      (globalThis as unknown as { watchdog: Bridge }).watchdog['getLatestScan']!()
    )) as Result<{ errors: unknown[]; burn: { exactUsdPerHour: number; unknownCount: number }; flags: { ruleId: string }[] }>
    expect(latest.value?.errors).toEqual([])
    expect(latest.value?.burn).toMatchObject({ exactUsdPerHour: 0.6564, unknownCount: 0 })
    expect(latest.value?.flags.map((flag) => flag.ruleId)).toContain('nat-gateway')

    const seen = await mainWindow.evaluate(() => (globalThis as unknown as { seenStates: { scanInProgress: boolean }[] }).seenStates)
    expect(seen.some((state) => state.scanInProgress)).toBe(true)
    expect(seen.at(-1)?.scanInProgress).toBe(false)
  })
})

test.describe('scan with the Free Tier API denied', () => {
  test.use({ fakeAws: 'freetier-denied' })

  test('still scans, without a plan, and says why', async ({ mainWindow }) => {
    await mainWindow.evaluate(() => (globalThis as unknown as { watchdog: Bridge }).watchdog['selectProfile']!({ profile: 'demo' }))

    await expect
      .poll(async () => {
        const latest = await mainWindow.evaluate(() => (globalThis as unknown as { watchdog: Bridge }).watchdog['getLatestScan']!())
        return latest.value ?? null
      }, { timeout: 15_000 })
      .toMatchObject({ plan: null, runway: null, errors: [{ scanner: 'freetier', code: 'access-denied' }] })
  })
})
