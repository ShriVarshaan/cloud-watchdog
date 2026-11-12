// Smoke test of the packaged app in release/win-unpacked, the exact files the
// installer copies. Run with `npm run test:packaged` (it packages first).
//
// The exe has its Node debugging fuse off, so Playwright's Electron launcher
// cannot attach. Instead the app is started as a user would start it, with
// two Chromium switches: a throwaway --user-data-dir (so the real install's
// database, settings and login item are never touched; see loginItem.ts)
// and --remote-debugging-port, which lets the test read the page over CDP.
// The fresh data folder has no profile chosen, so no AWS call is made.

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { FuseV1Options, getCurrentFuseWire } from '@electron/fuses'
import { chromium, expect, test, type Browser, type Page } from '@playwright/test'

const APP_DIR = resolve('release', 'win-unpacked')
const EXE = join(APP_DIR, 'Cloud Watchdog.exe')

let userData: string
let child: ChildProcess
let browser: Browser
let page: Page

/** Chromium writes the port it chose into the data folder once it listens. */
async function devToolsPort(): Promise<number> {
  const file = join(userData, 'DevToolsActivePort')
  await expect.poll(() => existsSync(file), { timeout: 20_000 }).toBe(true)
  return Number(readFileSync(file, 'utf8').split('\n')[0])
}

/** The main window's page: the one whose query says view=main. */
async function mainPage(): Promise<Page> {
  let found: Page | undefined
  await expect
    .poll(
      () => {
        found = browser
          .contexts()
          .flatMap((context) => context.pages())
          .find((p) => new URL(p.url()).searchParams.get('view') === 'main')
        return found !== undefined
      },
      { timeout: 20_000 }
    )
    .toBe(true)
  return found!
}

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  expect(existsSync(EXE), `${EXE} is missing: run npm run dist:dir first`).toBe(true)
  userData = mkdtempSync(join(tmpdir(), 'cloud-watchdog-packaged-'))
  // A clean environment: none of the development switches may reach the app.
  const env = { ...process.env }
  for (const name of ['WATCHDOG_FAKE_AWS', 'WATCHDOG_FAKE_CONFIRM', 'CW_USER_DATA_DIR', 'ELECTRON_RENDERER_URL']) {
    delete env[name]
  }
  child = spawn(EXE, [`--user-data-dir=${userData}`, '--remote-debugging-port=0'], { env, stdio: 'ignore' })
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${await devToolsPort()}`)
  page = await mainPage()
  await page.waitForLoadState('load')
})

test.afterAll(async () => {
  if (browser) {
    // Closing the browser over CDP quits the app the way the tray's Quit does.
    const session = await browser.newBrowserCDPSession()
    await session.send('Browser.close').catch(() => {})
  }
  if (child && child.exitCode === null) {
    await new Promise<void>((done) => {
      const timer = setTimeout(() => {
        child.kill()
        done()
      }, 10_000)
      child.once('exit', () => {
        clearTimeout(timer)
        done()
      })
    })
  }
  rmSync(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 })
})

test('the exe carries the hardening fuses', async () => {
  const wire = await getCurrentFuseWire(EXE)
  const on = (option: FuseV1Options): boolean => String.fromCharCode(wire[option] as number) === '1'
  expect({
    runAsNode: on(FuseV1Options.RunAsNode),
    nodeOptions: on(FuseV1Options.EnableNodeOptionsEnvironmentVariable),
    inspect: on(FuseV1Options.EnableNodeCliInspectArguments),
    asarIntegrity: on(FuseV1Options.EnableEmbeddedAsarIntegrityValidation),
    onlyAsar: on(FuseV1Options.OnlyLoadAppFromAsar),
    cookieEncryption: on(FuseV1Options.EnableCookieEncryption)
  }).toEqual({
    runAsNode: false,
    nodeOptions: false,
    inspect: false,
    asarIntegrity: true,
    onlyAsar: true,
    cookieEncryption: true
  })
})

test('the main window loads the built page from app.asar', async () => {
  expect(page.url()).toMatch(/^file:\/\/.*\/resources\/app\.asar\/out\/renderer\/index\.html\?/)
  await expect(page).toHaveTitle('Cloud Watchdog')
})

test('the renderer is sandboxed, with only the preload bridge', async () => {
  const globals = await page.evaluate(() => {
    const g = globalThis as Record<string, unknown>
    return {
      require: typeof g['require'],
      process: typeof g['process'],
      apiVersion: (g['watchdog'] as { apiVersion?: number } | undefined)?.apiVersion
    }
  })
  expect(globals).toEqual({ require: 'undefined', process: 'undefined', apiVersion: 1 })
})

test('the page reaches the main process: the IPC sender check accepts app.asar', async () => {
  const result = await page.evaluate(() =>
    (globalThis as unknown as { watchdog: { getState(): Promise<{ ok: boolean }> } }).watchdog.getState()
  )
  expect(result.ok).toBe(true)
  // With no profile chosen yet, the welcome screen asks for one.
  await expect(page.getByRole('heading', { name: 'Choose the AWS account to watch' })).toBeVisible()
})

test('the database is created in the data folder, with its schema', async () => {
  const file = join(userData, 'watchdog.db')
  expect(existsSync(file)).toBe(true)
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()
    expect(tables.length).toBeGreaterThan(0)
  } finally {
    db.close()
  }
})
