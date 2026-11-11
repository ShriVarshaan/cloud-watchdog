// The guard around the only code that changes anything in an AWS account:
// stopping an EC2 instance and stopping an RDS database. Everything that
// decides whether a stop may happen is here; a driver (stopEc2.ts, stopRds.ts)
// only knows how to look at one kind of resource and how to stop it.
//
// A stop takes two steps, and the UI cannot skip either:
//
//   preview   looks at the resource in AWS right now, lists what stopping it
//             means and what forbids it, and (only when nothing forbids it)
//             hands out a one-time token
//   execute   takes nothing but that token
//
// What execute does, in order. Any "no" ends it, and nothing is stopped:
//
//   1. the token exists, was not used before, and is under 60 seconds old.
//      It is spent at this point, whatever happens next
//   2. it was issued in this session (same profile, same clients)
//   3. stopping is still switched on
//   4. the user confirms in a dialog shown by the main process
//   5. the session did not end while the dialog was open
//   6. the profile still signs in to the same account
//   7. the resource, looked at again, is exactly as it was at the preview
//   8. the attempt is written to the action log
//   9. the stop call is sent, and its outcome is written to the same row
//
// Every call to execute leaves a row in the action log.

import type { IpcErrorCode, IpcResult } from '../../shared/ipc'
import type { ActionKind, ActionPreview, ActionResult, AttrValue, Resource, ResourceKind } from '../../shared/types'
import type { ClientFactory } from '../aws/clients'
import { classifyAwsError } from '../aws/errors'
import { getIdentity } from '../aws/identity'
import type { ActionLogResult, Repo } from '../store/repo'

/** How long a preview's token can be used. */
export const TOKEN_TTL_MS = 60_000
/** Spent and expired tokens are remembered this long, so a late use can be explained and recorded. */
const FORGET_AFTER_MS = 10 * 60_000

/** What a driver saw: the state, plus everything else its blockers and consequences depend on. */
export type Facts = { state: string } & Record<string, AttrValue>

export interface ActionDriver {
  action: ActionKind
  kind: ResourceKind
  /** Looks at the resource in AWS right now. null = AWS no longer lists it. */
  observe(clients: ClientFactory, region: string, id: string): Promise<Facts | null>
  /** Reasons the app refuses to stop it. Empty = it may be stopped. */
  blockers(facts: Facts): string[]
  /** What keeps costing money or changes once it is stopped. */
  consequences(facts: Facts): string[]
  /** Asks AWS whether the profile may stop it, without stopping it. Returns the reason it may not. */
  checkPermission?(clients: ClientFactory, region: string, id: string): Promise<string | null>
  /** The one call that changes something. */
  stop(clients: ClientFactory, region: string, id: string): Promise<void>
  /** Shown after AWS accepted the stop. */
  done: string
}

/** What the confirmation dialog must name. Built here, shown by the main process. */
export interface Confirmation {
  action: ActionKind
  accountId: string
  profile: string
  region: string
  id: string
  name: string | null
  consequences: string[]
}

export interface ExecuteOptions {
  /** The current session's clients. Must be the ones the preview was made with. */
  clients: ClientFactory
  /** Shows the confirmation and resolves to true only if the user agreed. */
  confirm(confirmation: Confirmation): Promise<boolean>
  /** Aborted when the session ends (profile change, quit). */
  signal: AbortSignal
  /** The account the app is signed in to, for the log row of a token that is not known. */
  accountId: string | null
}

export interface ActionGuardDeps {
  drivers: readonly ActionDriver[]
  /** Whether the user has switched stopping on. Asked on every call. */
  enabled(): boolean
  log: Pick<Repo, 'addActionLog' | 'finishActionLog'>
  now?: () => Date
}

export interface ActionGuard {
  preview(clients: ClientFactory, resource: Resource, action: ActionKind): Promise<IpcResult<ActionPreview>>
  execute(token: string, options: ExecuteOptions): Promise<IpcResult<ActionResult>>
}

interface Issued {
  clients: ClientFactory
  driver: ActionDriver
  accountId: string
  resourceKey: string
  region: string
  id: string
  name: string | null
  /** Everything observed at the preview, in a comparable form. */
  fingerprint: string
  state: string
  consequences: string[]
  expiresAt: number
  used: boolean
}

const AGAIN = 'Open the stop preview again.'

function refuse(code: IpcErrorCode, message: string): IpcResult<never> {
  return { ok: false, error: { code, message } }
}

function fingerprintOf(facts: Facts): string {
  return JSON.stringify(Object.entries(facts).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
}

function newToken(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return Buffer.from(bytes).toString('base64url')
}

export function createActionGuard(deps: ActionGuardDeps): ActionGuard {
  const now = deps.now ?? (() => new Date())
  const issued = new Map<string, Issued>()

  function forgetOld(): void {
    const cutoff = now().getTime() - FORGET_AFTER_MS
    for (const [token, entry] of issued) {
      if (entry.expiresAt < cutoff) issued.delete(token)
    }
  }

  return {
    async preview(clients, resource, action) {
      forgetOld()
      if (!deps.enabled()) return refuse('refused', 'Stopping resources is switched off. Turn it on in Settings first.')

      const driver = deps.drivers.find((candidate) => candidate.action === action)
      if (!driver || driver.kind !== resource.kind) {
        return refuse('refused', 'That action does not apply to this kind of resource.')
      }
      const accountId = resource.key.split(':')[0]!

      let facts: Facts | null
      let blockers: string[]
      try {
        const who = await getIdentity(clients)
        if (who.accountId !== accountId) {
          return refuse(
            'refused',
            `The profile now signs in to account ${who.accountId}, but this resource is in account ${accountId}. Nothing was done.`
          )
        }
        facts = await driver.observe(clients, resource.region, resource.id)
        if (!facts) return refuse('not-found', 'AWS no longer lists this resource. Scan again.')

        blockers = driver.blockers(facts)
        if (blockers.length === 0 && driver.checkPermission) {
          const denied = await driver.checkPermission(clients, resource.region, resource.id)
          if (denied) blockers = [denied]
        }
      } catch (error) {
        const { code, message } = classifyAwsError(error)
        return refuse(code, message)
      }

      const consequences = driver.consequences(facts)
      const base = { resourceKey: resource.key, action, liveState: facts.state, consequences, blockers }
      if (blockers.length > 0) return { ok: true, value: { ...base, token: null, expiresAt: null } }

      const token = newToken()
      const expiresAt = now().getTime() + TOKEN_TTL_MS
      issued.set(token, {
        clients,
        driver,
        accountId,
        resourceKey: resource.key,
        region: resource.region,
        id: resource.id,
        name: resource.name ?? null,
        fingerprint: fingerprintOf(facts),
        state: facts.state,
        consequences,
        expiresAt,
        used: false
      })
      return { ok: true, value: { ...base, token, expiresAt: new Date(expiresAt).toISOString() } }
    },

    async execute(token, options) {
      forgetOld()
      const at = now()
      const entry = issued.get(token)

      if (!entry) {
        const message = `That confirmation is not valid. ${AGAIN}`
        deps.log.addActionLog({
          at: at.toISOString(),
          accountId: options.accountId ?? 'unknown',
          resourceKey: '',
          action: 'unknown',
          preState: null,
          result: 'refused',
          error: message
        })
        return refuse('refused', message)
      }

      const row = (result: ActionLogResult, error: string | null): number =>
        deps.log.addActionLog({
          at: at.toISOString(),
          accountId: entry.accountId,
          resourceKey: entry.resourceKey,
          action: entry.driver.action,
          preState: entry.state,
          result,
          error
        })
      const refused = (message: string, code: IpcErrorCode = 'refused'): IpcResult<never> => {
        row('refused', message)
        return refuse(code, message)
      }

      // 1. One use, within 60 seconds. The token is spent before anything else is looked at.
      if (entry.used) return refused(`That confirmation was already used. ${AGAIN}`)
      entry.used = true
      if (at.getTime() >= entry.expiresAt) return refused(`That confirmation has expired. ${AGAIN}`)

      // 2. Same session.
      if (options.clients !== entry.clients) {
        return refused(`The AWS profile was changed after the preview. Nothing was done. ${AGAIN}`)
      }
      // 3. Still switched on.
      if (!deps.enabled()) return refused('Stopping resources is switched off. Turn it on in Settings first.')

      // 4. The user agrees, in a dialog the UI cannot answer for them.
      const agreed = await options.confirm({
        action: entry.driver.action,
        accountId: entry.accountId,
        profile: entry.clients.profile,
        region: entry.region,
        id: entry.id,
        name: entry.name,
        consequences: entry.consequences
      })
      if (!agreed) {
        row('cancelled', null)
        return refuse('cancelled', 'Cancelled. Nothing was changed.')
      }

      // 5. The dialog may have been open for any length of time.
      if (options.signal.aborted) {
        return refused('The AWS profile was changed while the confirmation was open. Nothing was done.')
      }

      // 6 and 7. Same account, and the resource is exactly as it was previewed.
      try {
        const who = await getIdentity(entry.clients)
        if (who.accountId !== entry.accountId) {
          return refused(
            `The profile now signs in to account ${who.accountId}, not ${entry.accountId} as at the preview. Nothing was done.`
          )
        }
        const facts = await entry.driver.observe(entry.clients, entry.region, entry.id)
        if (!facts) return refused('AWS no longer lists this resource. Nothing was done. Scan again.', 'not-found')
        if (fingerprintOf(facts) !== entry.fingerprint) {
          const what =
            facts.state !== entry.state
              ? `it was ${entry.state} and is now ${facts.state}`
              : 'its details are no longer what the preview showed'
          return refused(`The resource changed since the preview: ${what}. Nothing was done. ${AGAIN}`)
        }
      } catch (error) {
        const { code, message } = classifyAwsError(error)
        return refused(`Could not check the resource again, so nothing was done: ${message}`, code)
      }

      // 8. No record, no stop.
      let rowId: number
      try {
        rowId = row('attempting', null)
      } catch {
        return refuse('refused', 'Cloud Watchdog could not write to its action log, so it did not stop anything.')
      }

      // 9. The only call that changes anything. If its outcome cannot be
      //    written, the row stays 'attempting', which is still true.
      const finish = (result: ActionLogResult, error: string | null): void => {
        try {
          deps.log.finishActionLog(rowId, result, error)
        } catch {
          // Nothing more can be done here; the attempt itself is on record.
        }
      }
      try {
        await entry.driver.stop(entry.clients, entry.region, entry.id)
      } catch (error) {
        const { code, message } = classifyAwsError(error)
        finish('failed', message)
        return refuse(code, `AWS did not stop it: ${message}`)
      }
      finish('stopped', null)
      return { ok: true, value: { resourceKey: entry.resourceKey, action: entry.driver.action, message: entry.driver.done } }
    }
  }
}
