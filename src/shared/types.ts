// The data model shared by the main process, the preload script and the UI.
// Types only (plus two small constant lists): nothing here may import Node,
// Electron or the AWS SDK, because the sandboxed renderer imports it too.

// ---------------------------------------------------------------------------
// Resources
// ---------------------------------------------------------------------------

export const RESOURCE_KINDS = [
  'ec2-instance',
  'ebs-volume',
  'elastic-ip',
  'nat-gateway',
  'rds-instance',
  'load-balancer',
  'sagemaker-endpoint'
] as const
export type ResourceKind = (typeof RESOURCE_KINDS)[number]

export type AttrValue = string | number | boolean | null

/** One thing in the AWS account that can cost money, as a scanner saw it. */
export interface Resource {
  /** `${accountId}:${kind}:${region}:${id}`. Stable across scans. */
  key: string
  kind: ResourceKind
  region: string
  id: string
  name?: string
  /** Normalised: running | stopped | available | in-use | ... */
  state: string
  /** ISO time, when AWS provides it. */
  createdAt?: string
  /** Inputs for pricing and rules (instance type, size, ...). */
  attrs: Record<string, AttrValue>
}

export function resourceKey(accountId: string, kind: ResourceKind, region: string, id: string): string {
  return `${accountId}:${kind}:${region}:${id}`
}

// ---------------------------------------------------------------------------
// Pricing and free-tier coverage
// ---------------------------------------------------------------------------

export type PriceConfidence = 'exact' | 'estimate' | 'unknown'

export interface Price {
  /** null if and only if confidence is 'unknown'. */
  hourlyUsd: number | null
  confidence: PriceConfidence
  source: 'price-list-api' | 'bundled' | 'none'
  /** Usage charges not in the rate, e.g. "NAT data processing per GB". */
  excluded: string[]
}

export type Coverage = 'covered' | 'not-covered' | 'unknown'

export interface PricedResource extends Resource {
  price: Price
  coverage: Coverage
  /**
   * true when the latest scan could not look at this resource (its scanner
   * failed in its region), so this is the last known data, not fresh data.
   */
  stale: boolean
}

// ---------------------------------------------------------------------------
// Flags (warnings raised by rules)
// ---------------------------------------------------------------------------

export type Severity = 'info' | 'warn' | 'critical'

export interface Flag {
  id: string
  ruleId: string
  /** null = the flag is about the account as a whole (e.g. credits running out). */
  resourceKey: string | null
  severity: Severity
  message: string
  firstSeenAt: string
  resolvedAt?: string
  dismissedUntil?: string
}

// ---------------------------------------------------------------------------
// Scan errors
// ---------------------------------------------------------------------------

/**
 * Why a call to AWS failed, reduced to what the app does about it.
 * `auth-expired` covers every "these credentials do not work, sign in again"
 * case (expired token, expired SSO session, profile that cannot be loaded).
 */
export type ScanErrorCode = 'access-denied' | 'throttled' | 'region-disabled' | 'auth-expired' | 'network' | 'unknown'

export type ScanErrorSource = ResourceKind | 'regions' | 'freetier' | 'pricing' | 'cloudwatch'

export interface ScanError {
  scanner: ScanErrorSource
  /** null when the failure is not tied to one region. */
  region: string | null
  code: ScanErrorCode
  message: string
}

// ---------------------------------------------------------------------------
// Plan, burn rate and runway
// ---------------------------------------------------------------------------

export interface PlanState {
  planType: 'FREE' | 'PAID'
  status: 'NOT_STARTED' | 'ACTIVE' | 'EXPIRED'
  remainingCreditsUsd: number | null
  expiresAt: string | null
  fetchedAt: string
}

/** Exact and estimated totals are never added together. */
export interface BurnRate {
  exactUsdPerHour: number
  estimateUsdPerHour: number
  /** Resources with no price at all. */
  unknownCount: number
}

export interface Runway {
  creditDays: number | null
  planDays: number | null
  /** The smaller of the two that exist. */
  days: number | null
  /** true when some cost is unpriced, so the real runway may be shorter. */
  isUpperBound: boolean
}

// ---------------------------------------------------------------------------
// Scan result
// ---------------------------------------------------------------------------

/** Who the app is signed in as. Shown on first run so the user can confirm the account. */
export interface Identity {
  accountId: string
  arn: string
  profile: string
}

export interface ScanResult {
  scanId: string
  startedAt: string
  finishedAt: string
  identity: Identity
  resources: PricedResource[]
  flags: Flag[]
  errors: ScanError[]
  burn: BurnRate
  plan: PlanState | null
  runway: Runway | null
}

/** The part of a scan the tray popover and tooltip need. */
export interface ScanSummary {
  scanId: string
  finishedAt: string
  burn: BurnRate
  plan: PlanState | null
  runway: Runway | null
  resourceCount: number
  openFlagCount: number
  errorCount: number
}

export interface ScanProgress {
  scanId: string
  /** (scanner, region) tasks finished so far, and in total. */
  done: number
  total: number
}

// ---------------------------------------------------------------------------
// Settings and app state
// ---------------------------------------------------------------------------

export interface RuleSetting {
  enabled: boolean
  /** Numeric thresholds, e.g. { hours: 24 }. Each rule defines its own (M7). */
  params: Record<string, number>
}

export interface Settings {
  /** AWS profile name from the user's AWS config. null until one is chosen. */
  profile: string | null
  scanIntervalMinutes: number
  notificationsEnabled: boolean
  startAtLogin: boolean
  /** Overrides per rule id. A rule that is not listed uses its defaults. */
  rules: Record<string, RuleSetting>
}

export const SCAN_INTERVAL_MINUTES = { min: 5, max: 1440, default: 15 } as const

export const DEFAULT_SETTINGS: Settings = {
  profile: null,
  scanIntervalMinutes: SCAN_INTERVAL_MINUTES.default,
  notificationsEnabled: true,
  startAtLogin: false,
  rules: {}
}

export interface AppState {
  /** null until a profile is selected and sts:GetCallerIdentity has succeeded. */
  identity: Identity | null
  settings: Settings
  lastScan: ScanSummary | null
  scanInProgress: boolean
  /**
   * Why scans are not working right now (the last scan could not even start),
   * in plain words. null when the last scan ran. Example: an expired sign-in,
   * with the command that fixes it.
   */
  problem: { code: ScanErrorCode; message: string } | null
}

// ---------------------------------------------------------------------------
// Manual steps and actions
// ---------------------------------------------------------------------------

/** What the user can do by hand. Built in the main process, never by the UI. */
export interface ManualSteps {
  consoleUrl: string
  /** A command to copy. The app never runs it. */
  cliCommand: string | null
}

export const ACTION_KINDS = ['stop-ec2', 'stop-rds'] as const
export type ActionKind = (typeof ACTION_KINDS)[number]

export interface ActionPreview {
  resourceKey: string
  action: ActionKind
  /** The resource's state as AWS reports it right now. */
  liveState: string
  /** What keeps costing money or changes after the action. */
  consequences: string[]
  /** Reasons the app refuses. When not empty, `token` is null. */
  blockers: string[]
  /** One-time token for `actions:execute`. Short-lived. */
  token: string | null
  expiresAt: string | null
}

export interface ActionResult {
  resourceKey: string
  action: ActionKind
  message: string
}
