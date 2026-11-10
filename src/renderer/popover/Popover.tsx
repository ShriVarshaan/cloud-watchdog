// The window that opens from the tray icon: the burn rate, the runway, the
// plan, the most important warnings, and a way to scan now.

import { useState } from 'react'
import { formatAgo } from '../../shared/format'
import { KIND_EXPLANATIONS } from '../../shared/explain'
import type { Flag, ScanResult } from '../../shared/types'
import { api, useAppState, useLatestScan, useNow, useScanProgress } from '../api'
import { SeverityMark } from '../components/Badges'
import { PlanBanner, ProblemBanner } from '../components/Banners'
import { BurnRateFigure, PlanFigure, RunwayGauge } from '../components/Summary'

const TOP_FLAGS = 3
const ORDER = { critical: 0, warn: 1, info: 2 } as const

function topFlags(latest: ScanResult, now: Date): Flag[] {
  return latest.flags
    .filter((flag) => !flag.dismissedUntil || Date.parse(flag.dismissedUntil) <= now.getTime())
    .sort((a, b) => ORDER[a.severity] - ORDER[b.severity])
    .slice(0, TOP_FLAGS)
}

function subject(flag: Flag, latest: ScanResult): string {
  if (flag.resourceKey === null) return 'Account'
  const resource = latest.resources.find((r) => r.key === flag.resourceKey)
  return resource ? `${KIND_EXPLANATIONS[resource.kind].name} ${resource.name ?? resource.id}` : 'Resource'
}

export function Popover() {
  const { state, error } = useAppState()
  const latest = useLatestScan(state)
  const progress = useScanProgress(state?.scanInProgress ?? false)
  const now = useNow()
  const [scanError, setScanError] = useState<string | null>(null)

  async function scanNow() {
    setScanError(null)
    const result = await api().runScan()
    if (!result.ok) setScanError(result.error.message)
  }

  if (error) return <main className="popover"><p role="alert">{error}</p></main>
  if (!state) return <main className="popover" aria-busy="true"><p>Loading</p></main>

  const summary = state.lastScan
  const flags = latest ? topFlags(latest, now) : []
  const hiddenFlags = summary ? summary.openFlagCount - flags.length : 0

  return (
    <main className="popover">
      <header className="popover-header">
        <h1>Cloud Watchdog</h1>
        <p className="quiet" aria-live="polite">
          {state.scanInProgress
            ? progress
              ? `Scanning, ${progress.done} of ${progress.total}`
              : 'Scanning'
            : summary
              ? `Scanned ${formatAgo(summary.finishedAt, now)}`
              : state.settings.profile
                ? 'Not scanned yet'
                : 'No AWS profile chosen'}
        </p>
      </header>

      <ProblemBanner problem={state.problem} />
      {summary && <PlanBanner plan={summary.plan} scanned />}

      {!state.settings.profile ? (
        <p>Open Cloud Watchdog from the tray menu and choose the AWS profile to watch.</p>
      ) : summary ? (
        <>
          <section className="popover-figures" aria-label="Summary">
            <BurnRateFigure burn={summary.burn} />
            <RunwayGauge runway={summary.runway} />
            <PlanFigure plan={summary.plan} />
          </section>

          <section aria-labelledby="popover-flags">
            <h2 id="popover-flags">Warnings</h2>
            {flags.length === 0 ? (
              <p className="quiet">Nothing needs attention.</p>
            ) : (
              <ul className="flag-list">
                {flags.map((flag) => (
                  <li key={flag.id}>
                    <SeverityMark severity={flag.severity} />
                    <span>
                      <strong>{subject(flag, latest!)}</strong> {flag.message}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {hiddenFlags > 0 && <p className="quiet">{hiddenFlags} more in the main window.</p>}
          </section>
        </>
      ) : null}

      <footer className="popover-footer">
        {summary && summary.errorCount > 0 && (
          <p className="quiet">
            {summary.errorCount} {summary.errorCount === 1 ? 'part' : 'parts'} of the last scan failed. Details are in the main window.
          </p>
        )}
        {scanError && <p role="alert">{scanError}</p>}
        {state.settings.profile && (
          <button type="button" className="button-primary" onClick={scanNow} disabled={state.scanInProgress}>
            {state.scanInProgress ? 'Scanning' : 'Scan now'}
          </button>
        )}
      </footer>
    </main>
  )
}
