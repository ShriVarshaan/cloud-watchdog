// Runs every enabled rule over a scan and collects the outcome:
//
//   drafts      flags that should exist now
//   undecided   (rule, resource) pairs the rules could not judge, as
//               `flagIdentity` strings. Their existing flags must be left alone.
//
// Anything that is in neither is a clear "does not match", and the flag
// lifecycle (flagLifecycle.ts) resolves a flag that was there before.
//
// A stale resource (its scanner failed, so its data is from an earlier scan)
// is not judged at all: every rule is undecided for it. Otherwise one
// throttled call would resolve flags, or raise new ones from old data.

import type { PlanState, Resource, RuleSetting, Runway, Severity } from '../../shared/types'
import type { CpuReading } from './idle'
import { ruleEnabled, ruleParams, RULES, type RuleContext } from './rules'

export interface FlagDraft {
  ruleId: string
  /** null = about the account as a whole. */
  resourceKey: string | null
  severity: Severity
  message: string
}

export type RuleResource = Resource & { stale: boolean }

export interface RuleInput {
  resources: readonly RuleResource[]
  plan: PlanState | null
  runway: Runway | null
  /** `Settings.rules`. */
  settings: Readonly<Record<string, RuleSetting>>
  /** CPU readings by resource key, or null when CloudWatch was not read. */
  cpu: ReadonlyMap<string, CpuReading> | null
  now: Date
}

export interface RuleOutcome {
  drafts: FlagDraft[]
  undecided: Set<string>
}

/** What makes two flags "the same flag": the rule and what it is about. */
export function flagIdentity(ruleId: string, resourceKey: string | null): string {
  return `${ruleId}|${resourceKey ?? 'account'}`
}

export function evaluateRules(input: RuleInput): RuleOutcome {
  const drafts: FlagDraft[] = []
  const undecided = new Set<string>()

  for (const rule of RULES) {
    // A rule that is off judges nothing, so the flags it raised earlier resolve.
    if (!ruleEnabled(input.settings, rule.id)) continue
    const ctx: RuleContext = {
      now: input.now,
      params: ruleParams(input.settings, rule.id),
      cpu: input.cpu,
      plan: input.plan,
      runway: input.runway
    }

    const record = (resourceKey: string | null, verdict: ReturnType<typeof rule.evaluate>) => {
      if (verdict === 'undecided') undecided.add(flagIdentity(rule.id, resourceKey))
      else if (verdict) drafts.push({ ruleId: rule.id, resourceKey, severity: rule.severity, message: verdict.message })
    }

    if (rule.scope === 'account') {
      record(null, rule.evaluate(ctx))
    } else {
      for (const resource of input.resources) {
        record(resource.key, resource.stale ? 'undecided' : rule.evaluate(resource, ctx))
      }
    }
  }

  return { drafts, undecided }
}
