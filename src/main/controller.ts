// The app's state and everything the IPC handlers do. No Electron imports:
// index.ts passes in what touches Electron (sending events, toasts, the tray
// tooltip, the login item), so all of this is unit-tested in plain Node.
//
// State:
//   settings   from settings.json
//   session    the chosen profile's AWS clients and scan machinery. Replaced
//              when the profile changes; the old one is cancelled first.
//   identity   who the profile signs in as, once known
//   latest     the last complete scan result
//   problem    why scans cannot run right now (expired sign-in, no network)
//
// Every change ends with one `state:changed` event and a new tray tooltip.

import type { IpcEventChannel, IpcEvents } from '../shared/ipc'
import type { AppState, Identity, ScanErrorCode, ScanResult, Settings } from '../shared/types'
import { ACTION_DRIVERS } from '../core/actions'
import { createActionGuard } from '../core/actions/guard'
import { buildManualSteps } from '../core/actions/manualSteps'
import type { ClientFactory } from '../core/aws/clients'
import { classifyAwsError } from '../core/aws/errors'
import { getIdentity } from '../core/aws/identity'
import { createPlanReader, type PlanReader } from '../core/freetier/planState'
import { createPricingEngine, type PricingEngine } from '../core/pricing/engine'
import { createPriceLookup } from '../core/pricing/priceListClient'
import { DISMISSED_UNTIL_RESOLVED } from '../core/rules/flagLifecycle'
import { createIdleDetector, type IdleDetector } from '../core/rules/idle'
import { createScanEngine, ScanAbortedError, ScanFailedError, type ScanEngine } from '../core/scan/engine'
import { previousResourcesFrom } from '../core/scan/persist'
import { completeScan, loadLatestResult, summarize } from '../core/scan/pipeline'
import { ALL_SCANNERS } from '../core/scanners'
import type { Repo } from '../core/store/repo'
import { enableActionsConfirmation, stopConfirmation, type ConfirmDialog } from './confirmations'
import { isAllowedExternalUrl } from './externalLinks'
import { fail, ok, type IpcHandlers } from './ipcHandlers'
import { planToasts, trayTooltip, type Toast } from './notifications'
import { createScheduler, type ScanOutcome, type Scheduler } from './scheduler'
import { applySettingsUpdate, loadSettings, saveSettings } from './settings'

export interface ControllerDeps {
  /** Where settings.json lives. */
  userDataDir: string
  repo: Repo
  listProfiles(): Promise<string[]>
  createClients(profile: string): ClientFactory
  emit<C extends IpcEventChannel>(channel: C, payload: IpcEvents[C]): void
  notify(toasts: Toast[]): void
  setTooltip(text: string): void
  setLoginItem(enabled: boolean): void
  /** Opens a web page in the user's browser. Called only with URLs that pass isAllowedExternalUrl. */
  openExternal(url: string): Promise<void>
  /** Shows a native confirmation dialog. Resolves to true only if the user chose the confirm button. */
  confirm(dialog: ConfirmDialog): Promise<boolean>
  /**
   * false when the database could not be opened and the app runs on a
   * temporary one. Nothing is stopped then, because the record of it would
   * be lost when the app closes. Default true.
   */
  actionLogOnDisk?: boolean
  log(message: string, error?: unknown): void
  now?: () => Date
}

export interface Controller {
  handlers: IpcHandlers
  /** Loads settings, applies the login item, and starts scanning if a profile is saved. */
  start(): void
  /** The computer woke from sleep. */
  onResume(): void
  /** Cancels any scan and stops the timer. */
  stop(): void
}

interface Session {
  profile: string
  clients: ClientFactory
  engine: ScanEngine
  pricing: PricingEngine
  plans: PlanReader
  idle: IdleDetector
  controller: AbortController
}

type Problem = NonNullable<AppState['problem']>

const SHORT_PROBLEM: Partial<Record<ScanErrorCode, string>> = {
  'auth-expired': 'sign-in expired',
  network: 'cannot reach AWS',
  'access-denied': 'access denied'
}

function signInProblem(profile: string): string {
  return `The sign-in for profile "${profile}" has expired or does not work. If it uses AWS SSO, sign in again with: aws sso login --profile ${profile}`
}

function problemFor(profile: string, code: ScanErrorCode, message: string): Problem {
  return { code, message: code === 'auth-expired' ? signInProblem(profile) : message }
}

export function createController(deps: ControllerDeps): Controller {
  const { repo } = deps
  const now = deps.now ?? (() => new Date())
  const actionLogOnDisk = deps.actionLogOnDisk ?? true

  let settings: Settings = loadSettings(deps.userDataDir).settings
  let session: Session | null = null
  let identity: Identity | null = null
  let latest: ScanResult | null = null
  let problem: Problem | null = null
  let scanning = false
  let currentScanId: string | null = null

  const scheduler: Scheduler = createScheduler({ run: () => runScan(), intervalMinutes: () => settings.scanIntervalMinutes })

  function state(): AppState {
    return {
      identity,
      settings,
      lastScan: latest ? summarize(latest, now()) : null,
      scanInProgress: scanning,
      problem
    }
  }

  function changed(): void {
    const current = state()
    deps.setTooltip(
      trayTooltip({
        hasProfile: settings.profile !== null,
        summary: current.lastScan,
        problem: problem ? (SHORT_PROBLEM[problem.code] ?? 'scan failed') : null
      })
    )
    deps.emit('state:changed', current)
  }

  function openSession(profile: string, clients: ClientFactory): Session {
    return {
      profile,
      clients,
      engine: createScanEngine({
        clients,
        scanners: ALL_SCANNERS,
        loadPrevious: previousResourcesFrom(repo),
        onProgress: (progress) => deps.emit('scan:progress', progress)
      }),
      pricing: createPricingEngine({ lookup: createPriceLookup(clients), cache: repo, now }),
      plans: createPlanReader({ clients, repo, now }),
      idle: createIdleDetector({ clients, cache: repo, now }),
      controller: new AbortController()
    }
  }

  function closeSession(): void {
    scheduler.stop()
    if (!session) return
    session.controller.abort()
    session.engine.abort()
    session.clients.destroy()
    session = null
  }

  /** One scheduled or requested scan. Nothing in here may await before engine.run(), so its id is known at once. */
  async function runScan(): Promise<ScanOutcome> {
    const current = session
    if (!current) return 'skipped'

    const running = current.engine.run()
    currentScanId = current.engine.currentScanId
    scanning = true
    changed()

    try {
      const raw = await running
      const { result, raised } = await completeScan(
        raw,
        { pricing: current.pricing, plans: current.plans, idle: current.idle, repo, rules: settings.rules, now },
        current.controller.signal
      )
      if (session !== current) return 'skipped'

      latest = result
      identity = result.identity
      problem = null
      if (settings.notificationsEnabled) {
        const toasts = planToasts(raised, result.resources)
        if (toasts.length > 0) deps.notify(toasts)
      }
      return 'ok'
    } catch (error) {
      if (error instanceof ScanAbortedError || session !== current) return 'skipped'
      if (error instanceof ScanFailedError) {
        problem = problemFor(current.profile, error.code, error.message)
        return error.code === 'auth-expired' ? 'auth-expired' : 'failed'
      }
      deps.log('Scan failed', error)
      problem = { code: 'unknown', message: 'The scan failed unexpectedly. It will be tried again.' }
      return 'failed'
    } finally {
      if (session === current) {
        scanning = false
        currentScanId = null
        changed()
      }
    }
  }

  function saveAndApply(next: Settings): void {
    const loginChanged = next.startAtLogin !== settings.startAtLogin
    const intervalChanged = next.scanIntervalMinutes !== settings.scanIntervalMinutes
    saveSettings(deps.userDataDir, next)
    settings = next
    if (loginChanged) deps.setLoginItem(settings.startAtLogin)
    if (intervalChanged) scheduler.reschedule()
  }

  /** A resource of the latest scan, looked up by the key the UI sent. */
  function findResource(resourceKey: string) {
    return latest?.resources.find((resource) => resource.key === resourceKey) ?? null
  }
  const NOT_IN_SCAN = 'That resource is not in the latest scan.'

  // The only way anything in AWS is changed. See core/actions/guard.ts.
  const guard = createActionGuard({
    drivers: ACTION_DRIVERS,
    enabled: () => settings.actionsEnabled && actionLogOnDisk,
    log: repo,
    now
  })

  /** One confirmation dialog at a time. A request made while one is open is refused, untouched. */
  let confirming = false
  const DIALOG_OPEN = 'Answer the confirmation that is already open first.'
  async function confirmOnce(dialog: ConfirmDialog): Promise<boolean> {
    confirming = true
    try {
      return await deps.confirm(dialog)
    } finally {
      confirming = false
    }
  }

  const handlers: IpcHandlers = {
    'app:getState': async () => ok(state()),

    'profiles:list': async () => ok(await deps.listProfiles()),

    'profiles:select': async ({ profile }) => {
      if (!(await deps.listProfiles()).includes(profile)) {
        return fail('not-found', `There is no AWS profile called "${profile}" on this computer.`)
      }
      const clients = deps.createClients(profile)
      let who: Identity
      try {
        who = await getIdentity(clients)
      } catch (error) {
        clients.destroy()
        const { code, message } = classifyAwsError(error)
        return fail(code, code === 'auth-expired' ? signInProblem(profile) : message)
      }

      closeSession()
      session = openSession(profile, clients)
      identity = who
      problem = null
      latest = loadLatestResult(repo, who.accountId, now())
      // Permission to stop things was given for one profile. It does not carry over to another.
      saveAndApply({ ...settings, profile, actionsEnabled: settings.actionsEnabled && profile === settings.profile })
      changed()
      scheduler.start()
      return ok(who)
    },

    'scan:run': async () => {
      if (!session) return fail('not-found', 'Choose an AWS profile first.')
      void scheduler.runNow()
      return currentScanId ? ok({ scanId: currentScanId }) : fail('internal', 'The scan could not be started.')
    },

    'scan:getLatest': async () => ok(latest),

    'flags:dismiss': async ({ flagId, hours }) => {
      const flag = latest?.flags.find((candidate) => candidate.id === flagId)
      if (!latest || !flag) return fail('not-found', 'That warning no longer exists.')
      const until = hours === undefined ? DISMISSED_UNTIL_RESOLVED : new Date(now().getTime() + hours * 3_600_000).toISOString()
      repo.setFlagDismissedUntil(flagId, until)
      latest = { ...latest, flags: latest.flags.map((candidate) => (candidate.id === flagId ? { ...candidate, dismissedUntil: until } : candidate)) }
      changed()
      return ok(null)
    },

    'settings:update': async (update) => {
      if (update.profile !== undefined && update.profile !== settings.profile) {
        return fail('invalid-input', 'Choose a profile with profiles:select.')
      }
      saveAndApply(applySettingsUpdate(settings, update))
      changed()
      return ok(settings)
    },

    'resource:manualSteps': async ({ resourceKey }) => {
      const resource = findResource(resourceKey)
      if (!resource) return fail('not-found', NOT_IN_SCAN)
      return ok(buildManualSteps(resource, session?.profile ?? settings.profile))
    },

    'resource:openConsole': async ({ resourceKey }) => {
      const resource = findResource(resourceKey)
      if (!resource) return fail('not-found', NOT_IN_SCAN)
      const { consoleUrl } = buildManualSteps(resource, null)
      // main built the URL, but it is checked again right before it leaves the app.
      if (!isAllowedExternalUrl(consoleUrl)) return fail('internal', 'That link cannot be opened.')
      await deps.openExternal(consoleUrl)
      return ok(null)
    },

    'actions:preview': async ({ resourceKey, action }) => {
      const resource = findResource(resourceKey)
      if (!session || !resource) return fail('not-found', NOT_IN_SCAN)
      return guard.preview(session.clients, resource, action)
    },

    'actions:execute': async ({ token }) => {
      if (!session) return fail('refused', 'Choose an AWS profile first.')
      if (confirming) return fail('refused', DIALOG_OPEN)
      const result = await guard.execute(token, {
        clients: session.clients,
        confirm: (confirmation) => confirmOnce(stopConfirmation(confirmation)),
        signal: session.controller.signal,
        accountId: identity?.accountId ?? null
      })
      // Show the new state as soon as AWS reports it.
      if (result.ok) void scheduler.runNow()
      return result
    },

    'actions:setEnabled': async ({ enabled }) => {
      if (confirming) return fail('refused', DIALOG_OPEN)
      if (enabled && !settings.actionsEnabled) {
        const current = session
        if (!current || !identity) return fail('refused', 'Choose an AWS profile first, and wait until Cloud Watchdog has signed in.')
        if (!actionLogOnDisk) {
          return fail(
            'refused',
            'Cloud Watchdog could not open its database, so it could not keep a record of what it stops. Stopping stays switched off.'
          )
        }
        if (!(await confirmOnce(enableActionsConfirmation(identity)))) {
          return fail('cancelled', 'Cancelled. Stopping stays switched off.')
        }
        if (session !== current) return fail('refused', 'The AWS profile was changed while the confirmation was open. Stopping stays switched off.')
      }
      saveAndApply({ ...settings, actionsEnabled: enabled })
      changed()
      return ok(settings)
    }
  }

  return {
    handlers,

    start() {
      const loaded = loadSettings(deps.userDataDir)
      if (loaded.problem) deps.log(loaded.problem)
      settings = loaded.settings
      if (settings.startAtLogin) deps.setLoginItem(true)
      if (settings.profile) {
        // The identity is read by the first scan; a failure there becomes a problem, and the scheduler retries.
        session = openSession(settings.profile, deps.createClients(settings.profile))
        changed()
        scheduler.start()
      } else {
        changed()
      }
    },

    onResume() {
      scheduler.onResume()
    },

    stop() {
      closeSession()
    }
  }
}
