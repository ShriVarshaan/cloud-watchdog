// Reads what kind of account this is and what pays for it:
//
//   GetAccountPlanState  free or paid plan, its status, the credits left and
//                        the end date
//   GetFreeTierUsage     this month's use of each free allowance (paginated)
//
// Both live on one global endpoint, reached through us-east-1.
//
// Usage is only fetched when it can change the answer: for a paid account
// without credits. With credits left, credits pay for everything (see
// coverage.ts), so the call is skipped.
//
// Neither call can fail a scan. A failure becomes a ScanError with scanner
// 'freetier' and the plan (or the usage) is reported as not known. Accounts
// opened before 15 July 2025 and Organization member accounts may not answer
// the plan call at all; they take this path.
//
// AWS updates these figures a few times a day, so an answer is reused for an
// hour. A failed plan call is not kept: the next scan tries again.

import { FreeTierClient, GetAccountPlanStateCommand, paginateGetFreeTierUsage, type FreeTierUsage } from '@aws-sdk/client-freetier'
import type { PlanState, ScanError } from '../../shared/types'
import { HOME_REGION, type ClientFactory } from '../aws/clients'
import { classifyAwsError } from '../aws/errors'
import type { Repo } from '../store/repo'

export const PLAN_REFRESH_MS = 60 * 60 * 1000

/** One free allowance and how much of it is used this month. */
export interface FreeTierUsageRow {
  service: string
  /** e.g. "Global-BoxUsage:freetier.micro". What coverage.ts matches resources against. */
  usageType: string
  operation: string
  /** A region code, or "global". */
  region: string
  /** null when AWS did not say. */
  actualUsage: number | null
  forecastedUsage: number | null
  limit: number
  unit: string
  /** "Always Free", "12 Months Free", "Free Trial". */
  freeTierType: string
}

export interface PlanReport {
  /** null = the plan could not be read. */
  plan: PlanState | null
  /** null = not fetched (not needed, or the call failed; a failure is in `errors`). */
  usage: FreeTierUsageRow[] | null
  errors: ScanError[]
}

export interface PlanReader {
  read(accountId: string, signal: AbortSignal): Promise<PlanReport>
}

export interface PlanReaderOptions {
  clients: ClientFactory
  repo: Pick<Repo, 'addPlanSnapshot'>
  now?: () => Date
}

const PLAN_TYPES = ['FREE', 'PAID'] as const
const PLAN_STATUSES = ['NOT_STARTED', 'ACTIVE', 'EXPIRED'] as const
const oneOf = <T extends string>(values: readonly T[], value: unknown): value is T => values.includes(value as T)

function toRow(row: FreeTierUsage): FreeTierUsageRow | null {
  if (!row.usageType || typeof row.limit !== 'number') return null
  return {
    service: row.service ?? '',
    usageType: row.usageType,
    operation: row.operation ?? '',
    region: row.region ?? '',
    actualUsage: row.actualUsageAmount ?? null,
    forecastedUsage: row.forecastedUsageAmount ?? null,
    limit: row.limit,
    unit: row.unit ?? '',
    freeTierType: row.freeTierType ?? ''
  }
}

export function createPlanReader(options: PlanReaderOptions): PlanReader {
  const { clients, repo } = options
  const now = options.now ?? (() => new Date())
  const recent = new Map<string, { at: number; report: PlanReport }>()

  async function fetchPlan(signal: AbortSignal): Promise<PlanState> {
    const response = await clients.get(FreeTierClient, HOME_REGION).send(new GetAccountPlanStateCommand({}), { abortSignal: signal })
    if (!oneOf(PLAN_TYPES, response.accountPlanType) || !oneOf(PLAN_STATUSES, response.accountPlanStatus)) {
      throw new Error(
        `AWS returned an account plan this app does not know (type "${response.accountPlanType}", status "${response.accountPlanStatus}").`
      )
    }
    const credits = response.accountPlanRemainingCredits
    return {
      planType: response.accountPlanType,
      status: response.accountPlanStatus,
      remainingCreditsUsd: credits && credits.unit === 'USD' && typeof credits.amount === 'number' ? credits.amount : null,
      // Always AWS's own date. It is never computed here.
      expiresAt: response.accountPlanExpirationDate?.toISOString() ?? null,
      fetchedAt: now().toISOString()
    }
  }

  async function fetchUsage(signal: AbortSignal): Promise<FreeTierUsageRow[]> {
    const client = clients.get(FreeTierClient, HOME_REGION)
    const rows: FreeTierUsageRow[] = []
    for await (const page of paginateGetFreeTierUsage({ client }, { maxResults: 1000 }, { abortSignal: signal })) {
      for (const usage of page.freeTierUsages ?? []) {
        const row = toRow(usage)
        if (row) rows.push(row)
      }
    }
    return rows
  }

  const failure = (error: unknown): ScanError => ({ scanner: 'freetier', region: null, ...classifyAwsError(error) })

  return {
    async read(accountId, signal) {
      const cached = recent.get(accountId)
      if (cached && now().getTime() - cached.at < PLAN_REFRESH_MS) return cached.report

      let plan: PlanState
      try {
        plan = await fetchPlan(signal)
      } catch (error) {
        if (signal.aborted) throw error
        return { plan: null, usage: null, errors: [failure(error)] }
      }
      repo.addPlanSnapshot(accountId, plan)

      const report: PlanReport = { plan, usage: null, errors: [] }
      const hasCredits = (plan.remainingCreditsUsd ?? 0) > 0
      if (plan.planType === 'PAID' && !hasCredits) {
        try {
          report.usage = await fetchUsage(signal)
        } catch (error) {
          if (signal.aborted) throw error
          report.errors.push(failure(error))
        }
      }

      recent.set(accountId, { at: now().getTime(), report })
      return report
    }
  }
}
