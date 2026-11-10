// The scan engine: runs every scanner in every enabled region and turns the
// outcome into one result. Scanners only call AWS and throw; everything that
// is easy to get wrong lives here.
//
//   Fan-out          one task per (scanner, region)
//   Concurrency      at most 8 tasks at once, at most 3 per AWS service
//   Partial failure  a failed task becomes a ScanError; the scan still succeeds
//   Staleness        resources last seen where a task failed are carried
//                    forward with `stale: true`, not treated as deleted
//   Single flight    run() during a scan returns that scan; scans never overlap
//   Abort            abort() cancels the scan; run() rejects with ScanAbortedError
//   Timeout          a task that takes too long is cancelled and reported
//
// Throttling is retried inside the SDK clients (adaptive mode, 5 attempts, see
// aws/clients.ts). What still fails after that arrives here as an error.
//
// The engine does not price, flag or save anything. It returns a RawScan.

import { randomUUID } from 'node:crypto'
import type { Identity, Resource, ScanError, ScanErrorCode, ScanProgress } from '../../shared/types'
import type { ClientFactory } from '../aws/clients'
import { classifyAwsError } from '../aws/errors'
import { getIdentity } from '../aws/identity'
import { listEnabledRegions } from '../aws/regions'
import { createLimiter } from './limiter'
import type { Scanner } from './scanner'

export const DEFAULT_GLOBAL_CONCURRENCY = 8
export const DEFAULT_PER_SERVICE_CONCURRENCY = 3
export const DEFAULT_TASK_TIMEOUT_MS = 60_000

/** A resource as the scan left it: seen just now, or carried over from before. */
export interface ScannedResource extends Resource {
  /** true = its scanner failed in its region this time, so this is older data. */
  stale: boolean
}

/** What a scan found, before pricing and rules. */
export interface RawScan {
  scanId: string
  startedAt: string
  finishedAt: string
  identity: Identity
  resources: ScannedResource[]
  errors: ScanError[]
}

/** run() rejects with this when abort() was called. Nothing should be saved. */
export class ScanAbortedError extends Error {
  constructor() {
    super('The scan was cancelled.')
    this.name = 'ScanAbortedError'
  }
}

/**
 * run() rejects with this when the scan could not even start, because the
 * profile's identity could not be read. `code` says why (usually
 * 'auth-expired' or 'network'), so the scheduler can back off.
 */
export class ScanFailedError extends Error {
  constructor(
    readonly code: ScanErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'ScanFailedError'
  }
}

export interface ScanEngineOptions {
  clients: ClientFactory
  scanners: readonly Scanner[]
  /**
   * The resources the previous scan of this account ended with (including
   * stale ones). Used only to carry resources forward when a task fails.
   */
  loadPrevious: (accountId: string) => readonly Resource[]
  /** Called once at the start and after each (scanner, region) task settles. */
  onProgress?: (progress: ScanProgress) => void
  globalConcurrency?: number
  perServiceConcurrency?: number
  /** How long one (scanner, region) task may run, not counting time spent queued. */
  taskTimeoutMs?: number
  now?: () => Date
}

export interface ScanEngine {
  /** Starts a scan, or joins the one in progress. */
  run(): Promise<RawScan>
  /** Cancels the scan in progress, if any. */
  abort(): void
  readonly inProgress: boolean
}

type TaskOutcome =
  | { scanner: Scanner; region: string; ok: true; resources: Resource[] }
  | { scanner: Scanner; region: string; ok: false; error: unknown }

function timeoutError(ms: number): Error {
  const error = new Error(`Timed out: no answer from AWS within ${Math.round(ms / 1000)} seconds.`)
  error.name = 'TimeoutError'
  return error
}

/** Copies only the `Resource` fields, so prices of a stored resource do not leak through. */
function carriedForward(resource: Resource): ScannedResource {
  return {
    key: resource.key,
    kind: resource.kind,
    region: resource.region,
    id: resource.id,
    ...(resource.name !== undefined ? { name: resource.name } : {}),
    state: resource.state,
    ...(resource.createdAt !== undefined ? { createdAt: resource.createdAt } : {}),
    attrs: resource.attrs,
    stale: true
  }
}

const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

export function createScanEngine(options: ScanEngineOptions): ScanEngine {
  const { clients, scanners, loadPrevious, onProgress } = options
  const taskTimeoutMs = options.taskTimeoutMs ?? DEFAULT_TASK_TIMEOUT_MS
  const now = options.now ?? (() => new Date())
  // One limiter for the life of the engine: tasks of a cancelled scan that are
  // still winding down keep counting against the caps.
  const limiter = createLimiter({
    globalMax: options.globalConcurrency ?? DEFAULT_GLOBAL_CONCURRENCY,
    perBucketMax: options.perServiceConcurrency ?? DEFAULT_PER_SERVICE_CONCURRENCY
  })

  let current: { controller: AbortController; promise: Promise<RawScan> } | null = null

  /** Runs one scanner in one region, with its own timeout. Never rejects. */
  async function runTask(scanner: Scanner, region: string, accountId: string, scanSignal: AbortSignal): Promise<TaskOutcome> {
    try {
      const resources = await limiter.run(
        scanner.service,
        async () => {
          // The task's own signal: aborted by the scan being cancelled or by the timeout.
          const controller = new AbortController()
          const onScanAbort = () => controller.abort()
          scanSignal.addEventListener('abort', onScanAbort, { once: true })

          let timer: ReturnType<typeof setTimeout> | undefined
          const timeout = new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              reject(timeoutError(taskTimeoutMs))
              controller.abort()
            }, taskTimeoutMs)
          })

          try {
            // Promise.resolve().then() also catches a scanner that throws synchronously.
            const scan = Promise.resolve().then(() =>
              scanner.scan({ accountId, region, clients, signal: controller.signal })
            )
            return await Promise.race([scan, timeout])
          } finally {
            clearTimeout(timer)
            scanSignal.removeEventListener('abort', onScanAbort)
          }
        },
        scanSignal
      )
      return { scanner, region, ok: true, resources }
    } catch (error) {
      return { scanner, region, ok: false, error }
    }
  }

  async function execute(signal: AbortSignal): Promise<RawScan> {
    const scanId = randomUUID()
    const startedAt = now().toISOString()

    let identity: Identity
    try {
      identity = await getIdentity(clients, signal)
    } catch (error) {
      if (signal.aborted) throw new ScanAbortedError()
      const { code, message } = classifyAwsError(error)
      throw new ScanFailedError(code, message)
    }
    if (signal.aborted) throw new ScanAbortedError()

    const accountId = identity.accountId
    const previous = loadPrevious(accountId).filter((resource) => resource.key.startsWith(`${accountId}:`))
    const errors: ScanError[] = []

    let regions: string[] | null = null
    try {
      regions = await listEnabledRegions(clients, signal)
    } catch (error) {
      if (signal.aborted) throw new ScanAbortedError()
      errors.push({ scanner: 'regions', region: null, ...classifyAwsError(error) })
    }
    if (signal.aborted) throw new ScanAbortedError()

    const tasks = (regions ?? []).flatMap((region) => scanners.map((scanner) => ({ scanner, region })))
    let done = 0
    onProgress?.({ scanId, done, total: tasks.length })

    const outcomes = await Promise.all(
      tasks.map(async ({ scanner, region }) => {
        const outcome = await runTask(scanner, region, accountId, signal)
        if (!signal.aborted) onProgress?.({ scanId, done: ++done, total: tasks.length })
        return outcome
      })
    )
    // If the scan was cancelled meanwhile, run() has already rejected and this result is dropped.

    // Keyed by resource key, so a resource a scanner returned twice is kept once.
    const found = new Map<string, ScannedResource>()
    // "kind|region" of every task that failed: what was there before is unknown now.
    const failed = new Set<string>()

    for (const outcome of outcomes) {
      if (outcome.ok) {
        for (const resource of outcome.resources) found.set(resource.key, { ...resource, stale: false })
      } else {
        failed.add(`${outcome.scanner.kind}|${outcome.region}`)
        errors.push({ scanner: outcome.scanner.kind, region: outcome.region, ...classifyAwsError(outcome.error) })
      }
    }

    for (const resource of previous) {
      // Not looked at this time: keep the last known data and say it is old.
      // If the region list itself failed, nothing was looked at.
      const notLookedAt = regions === null || failed.has(`${resource.kind}|${resource.region}`)
      if (notLookedAt && !found.has(resource.key)) found.set(resource.key, carriedForward(resource))
    }

    return {
      scanId,
      startedAt,
      finishedAt: now().toISOString(),
      identity,
      resources: [...found.values()].sort((a, b) => byText(a.key, b.key)),
      errors: errors.sort((a, b) => byText(a.scanner, b.scanner) || byText(a.region ?? '', b.region ?? ''))
    }
  }

  return {
    run(): Promise<RawScan> {
      if (current) return current.promise

      const controller = new AbortController()
      // Rejects the moment abort() is called, without waiting for tasks to wind down.
      const aborted = new Promise<never>((_, reject) => {
        controller.signal.addEventListener('abort', () => reject(new ScanAbortedError()), { once: true })
      })
      const promise = Promise.race([execute(controller.signal), aborted]).finally(() => {
        if (current?.controller === controller) current = null
      })
      current = { controller, promise }
      return promise
    },

    abort(): void {
      current?.controller.abort()
    },

    get inProgress(): boolean {
      return current !== null
    }
  }
}
