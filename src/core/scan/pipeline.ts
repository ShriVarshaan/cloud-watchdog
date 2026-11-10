// What happens to a scan after the engine returns it, in order:
//
//   1. price every resource                      pricing/engine.ts
//   2. read the account plan and free tier use   freetier/planState.ts
//   3. decide coverage per resource               freetier/coverage.ts
//   4. work out the credit runway                 freetier/runway.ts
//   5. read CPU, if the idle rule is on           rules/idle.ts
//   6. run the rules and update the flags         rules/engine.ts, flagLifecycle.ts
//   7. save the scan and prune old history
//
// None of the steps can fail the scan: each one degrades and adds a
// ScanError instead. Only cancellation stops it, and then nothing is saved.

import type { Flag, RuleSetting, ScanResult, ScanSummary } from '../../shared/types'
import { decideCoverage } from '../freetier/coverage'
import type { PlanReader } from '../freetier/planState'
import { computeRunway } from '../freetier/runway'
import type { PricingEngine } from '../pricing/engine'
import { evaluateRules } from '../rules/engine'
import { isDismissed, updateFlags } from '../rules/flagLifecycle'
import type { IdleDetector } from '../rules/idle'
import { ruleEnabled, ruleParams } from '../rules/rules'
import type { Repo } from '../store/repo'
import { ScanAbortedError, type RawScan } from './engine'

/** History (scans, their errors and observations) is kept this long. */
export const HISTORY_DAYS = 30
const DAY_MS = 24 * 60 * 60 * 1000

export interface PipelineDeps {
  pricing: PricingEngine
  plans: PlanReader
  idle: IdleDetector
  repo: Repo
  /** `Settings.rules`, read at the time of the scan. */
  rules: Readonly<Record<string, RuleSetting>>
  now: () => Date
}

export interface CompletedScan {
  result: ScanResult
  /** Flags that are new in this scan. These are the ones to notify. */
  raised: Flag[]
}

/** Open flags in the order the store lists them. */
function byFirstSeen(a: Flag, b: Flag): number {
  return a.firstSeenAt < b.firstSeenAt ? -1 : a.firstSeenAt > b.firstSeenAt ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

export async function completeScan(raw: RawScan, deps: PipelineDeps, signal: AbortSignal): Promise<CompletedScan> {
  const { repo } = deps
  const accountId = raw.identity.accountId

  const priced = await deps.pricing.price(raw.resources, signal)
  const planReport = await deps.plans.read(accountId, signal)

  const resources = priced.resources.map((resource) => ({
    ...resource,
    coverage: decideCoverage(resource, planReport.plan, planReport.usage).coverage
  }))
  const runway = computeRunway(planReport.plan, priced.burn, resources.map((resource) => resource.price), deps.now())

  const cpuReport = ruleEnabled(deps.rules, 'idle-cpu')
    ? await deps.idle.read(resources, ruleParams(deps.rules, 'idle-cpu').windowHours!, signal)
    : null
  if (signal.aborted) throw new ScanAbortedError()

  const now = deps.now()
  const outcome = evaluateRules({
    resources,
    plan: planReport.plan,
    runway,
    settings: deps.rules,
    cpu: cpuReport?.readings ?? null,
    now
  })

  const errors = [...raw.errors, ...priced.errors, ...planReport.errors, ...(cpuReport?.errors ?? [])]
  const result: ScanResult = {
    scanId: raw.scanId,
    startedAt: raw.startedAt,
    finishedAt: raw.finishedAt,
    identity: raw.identity,
    resources,
    flags: [],
    errors,
    burn: priced.burn,
    plan: planReport.plan,
    runway
  }

  repo.saveScan(result)
  const changes = updateFlags(repo, accountId, outcome, now)
  repo.pruneScansBefore(new Date(now.getTime() - HISTORY_DAYS * DAY_MS).toISOString())

  return { result: { ...result, flags: [...changes.open].sort(byFirstSeen) }, raised: changes.raised }
}

/**
 * The last saved result of an account, for when the app starts. The plan is
 * the last one read (it may be older than the scan); the runway is worked
 * out again from it. The scan that runs on start replaces both within seconds.
 */
export function loadLatestResult(repo: Repo, accountId: string, now: Date): ScanResult | null {
  const stored = repo.getLatestScan(accountId)
  if (!stored) return null
  const plan = repo.getLatestPlanSnapshot(accountId)
  return {
    ...stored,
    flags: repo.listFlags(accountId),
    plan,
    runway: computeRunway(plan, stored.burn, stored.resources.map((resource) => resource.price), now)
  }
}

export function summarize(result: ScanResult, now: Date): ScanSummary {
  return {
    scanId: result.scanId,
    finishedAt: result.finishedAt,
    burn: result.burn,
    plan: result.plan,
    runway: result.runway,
    resourceCount: result.resources.length,
    openFlagCount: result.flags.filter((flag) => !flag.resolvedAt && !isDismissed(flag, now)).length,
    errorCount: result.errors.length
  }
}
