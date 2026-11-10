// What the app says outside its windows: Windows toasts for new flags, and
// the tray icon's tooltip. Plain functions that build text; index.ts shows
// it with Electron's Notification and Tray.
//
// Toasts: one per new flag, most severe first. More than three at once
// (typically the first scan of a busy account) become a single toast, so the
// user is not buried. Clicking a toast opens the main window on its resource.

import type { Flag, PricedResource, ResourceKind, ScanSummary, Severity } from '../shared/types'

export interface Toast {
  title: string
  body: string
  /** The resource to show when the toast is clicked. null = just open the main window. */
  resourceKey: string | null
  /** Critical: shown with urgency. */
  urgent: boolean
}

export const MAX_SEPARATE_TOASTS = 3
/** Windows cuts tray tooltips at 127 characters. */
const TOOLTIP_MAX = 127

const KIND_LABEL: Record<ResourceKind, string> = {
  'ec2-instance': 'EC2 instance',
  'ebs-volume': 'EBS volume',
  'elastic-ip': 'Elastic IP',
  'nat-gateway': 'NAT gateway',
  'rds-instance': 'RDS database',
  'load-balancer': 'Load balancer',
  'sagemaker-endpoint': 'SageMaker endpoint'
}

const SEVERITY_ORDER: Record<Severity, number> = { critical: 0, warn: 1, info: 2 }

function titleFor(flag: Flag, byKey: ReadonlyMap<string, PricedResource>): string {
  if (flag.resourceKey === null) return 'AWS account'
  const resource = byKey.get(flag.resourceKey)
  if (!resource) return flag.resourceKey
  return `${KIND_LABEL[resource.kind]} ${resource.name ?? resource.id} (${resource.region})`
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`
}

export function planToasts(raised: readonly Flag[], resources: readonly PricedResource[]): Toast[] {
  if (raised.length === 0) return []
  const sorted = [...raised].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity])

  if (sorted.length > MAX_SEPARATE_TOASTS) {
    const count = (severity: Severity) => sorted.filter((flag) => flag.severity === severity).length
    const parts = [
      count('critical') ? `${count('critical')} critical` : '',
      count('warn') ? plural(count('warn'), 'warning', 'warnings') : '',
      count('info') ? plural(count('info'), 'note', 'notes') : ''
    ].filter(Boolean)
    return [
      {
        title: `${sorted.length} new warnings in your AWS account`,
        body: `${parts.join(', ')}. Open Cloud Watchdog to see them.`,
        resourceKey: null,
        urgent: count('critical') > 0
      }
    ]
  }

  const byKey = new Map(resources.map((resource) => [resource.key, resource]))
  return sorted.map((flag) => ({
    title: titleFor(flag, byKey),
    body: flag.message,
    resourceKey: flag.resourceKey,
    urgent: flag.severity === 'critical'
  }))
}

export function formatUsdPerHour(usd: number): string {
  if (usd === 0) return '$0/h'
  if (usd < 0.001) return '<$0.001/h'
  // Three decimals below 10 cents, so $0.048 does not read as $0.05; a trailing zero is dropped.
  if (usd < 0.1) return `$${usd.toFixed(3).replace(/0$/, '')}/h`
  return `$${usd.toFixed(2)}/h`
}

export interface TooltipState {
  hasProfile: boolean
  summary: ScanSummary | null
  /** A short problem to show first, such as an expired sign-in. */
  problem: string | null
}

export function trayTooltip(state: TooltipState): string {
  if (!state.hasProfile) return 'Cloud Watchdog: choose an AWS profile'

  const lines = [state.problem ? `Cloud Watchdog: ${state.problem}` : 'Cloud Watchdog']
  const summary = state.summary
  if (!summary) {
    if (!state.problem) return 'Cloud Watchdog: no scan yet'
  } else {
    const { exactUsdPerHour, estimateUsdPerHour, unknownCount } = summary.burn
    let rate = formatUsdPerHour(exactUsdPerHour)
    if (estimateUsdPerHour > 0) rate += ` + about ${formatUsdPerHour(estimateUsdPerHour)} estimated`
    if (unknownCount > 0) rate += `, ${unknownCount} unpriced`
    lines.push(rate)
    if (summary.openFlagCount > 0) lines.push(plural(summary.openFlagCount, 'warning', 'warnings'))
  }

  const text = lines.join('\n')
  return text.length <= TOOLTIP_MAX ? text : `${text.slice(0, TOOLTIP_MAX - 1)}…`
}
