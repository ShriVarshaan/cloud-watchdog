import { expect, test } from './fixtures'

test.describe('app launch and renderer hardening', () => {
  test('opens the main window', async ({ mainWindow }) => {
    await expect(mainWindow).toHaveTitle('Cloud Watchdog')
    await expect(mainWindow.getByRole('heading', { level: 1 })).toHaveText('Cloud Watchdog')
  })

  test('every window runs sandboxed with context isolation and no Node integration', async ({
    app,
    mainWindow
  }) => {
    await mainWindow.waitForLoadState('load')
    const prefs = await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().map((w) => {
        // getLastWebPreferences() exists at runtime but is missing from
        // Electron's type definitions; it reports the preferences in force.
        const contents = w.webContents as typeof w.webContents & {
          getLastWebPreferences(): Electron.WebPreferences | null
        }
        const p = contents.getLastWebPreferences()
        return {
          contextIsolation: p?.contextIsolation,
          sandbox: p?.sandbox,
          nodeIntegration: p?.nodeIntegration,
          webSecurity: p?.webSecurity
        }
      })
    )
    expect(prefs.length).toBeGreaterThan(0)
    for (const p of prefs) {
      expect(p).toEqual({ contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true })
    }
  })

  test('the renderer has no Node globals', async ({ mainWindow }) => {
    const globals = await mainWindow.evaluate(() => ({
      require: typeof (globalThis as Record<string, unknown>).require,
      process: typeof (globalThis as Record<string, unknown>).process,
      module: typeof (globalThis as Record<string, unknown>).module
    }))
    expect(globals).toEqual({ require: 'undefined', process: 'undefined', module: 'undefined' })
  })

  test('the preload bridge loaded under the sandbox', async ({ mainWindow }) => {
    const apiVersion = await mainWindow.evaluate(
      () => (globalThis as unknown as { watchdog?: { apiVersion: number } }).watchdog?.apiVersion
    )
    expect(apiVersion).toBe(1)
  })

  test('the strict Content-Security-Policy is applied', async ({ mainWindow }) => {
    const csp = await mainWindow.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content')
    expect(csp).toContain("default-src 'self'")
    expect(csp).toContain("script-src 'self'")
    expect(csp).toContain("object-src 'none'")
    expect(csp).not.toMatch(/script-src[^;]*unsafe-inline/)
  })

  test('window.open is refused', async ({ app, mainWindow }) => {
    const before = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)
    const opened = await mainWindow.evaluate(() => window.open('https://example.com') !== null)
    const after = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)
    expect(opened).toBe(false)
    expect(after).toBe(before)
  })

  test('navigation away from the app is blocked', async ({ mainWindow }) => {
    const urlBefore = mainWindow.url()
    await mainWindow.evaluate(() => {
      window.location.href = 'https://example.com/'
    })
    await mainWindow.waitForTimeout(500)
    expect(mainWindow.url()).toBe(urlBefore)
  })

  test('closing the main window keeps the app running in the tray', async ({ app, mainWindow }) => {
    await mainWindow.waitForLoadState('load')
    // Same path as the title-bar X button. (A page calling window.close()
    // skips the 'close' event in Electron, so it is not what users do.)
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close())
    await expect
      .poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some((w) => w.isVisible())))
      .toBe(false)
    // The window is hidden, not destroyed, and the main process still answers.
    const windowCount = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)
    expect(windowCount).toBeGreaterThan(0)
  })
})
