// The main window: who the app is signed in as, the summary, and three tabs:
// resources (with the detail panel), scan problems and settings.

import { useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { formatAgo } from '../../shared/format'
import type { Flag } from '../../shared/types'
import { api, useAppState, useLatestScan, useNow, useScanProgress } from '../api'
import { PlanBanner, ProblemBanner } from '../components/Banners'
import { BurnRateFigure, PlanFigure, RunwayGauge } from '../components/Summary'
import { DetailPanel } from './DetailPanel'
import { FirstRun } from './FirstRun'
import { buildRows, ResourceTable } from './ResourceTable'
import { ScanErrors } from './ScanErrors'
import { SettingsPanel } from './SettingsPanel'

type Tab = 'resources' | 'problems' | 'settings'
const TABS: Tab[] = ['resources', 'problems', 'settings']

function visible(flags: readonly Flag[], now: Date): Flag[] {
  return flags.filter((flag) => !flag.dismissedUntil || Date.parse(flag.dismissedUntil) <= now.getTime())
}

export function MainWindow({ focusKey = null }: { focusKey?: string | null }) {
  const { state, error } = useAppState()
  const latest = useLatestScan(state)
  const progress = useScanProgress(state?.scanInProgress ?? false)
  const now = useNow()
  const [tab, setTab] = useState<Tab>('resources')
  const [selectedKey, setSelectedKey] = useState<string | null>(focusKey)
  const [scanError, setScanError] = useState<string | null>(null)
  const tabRefs = useRef<Record<Tab, HTMLButtonElement | null>>({ resources: null, problems: null, settings: null })

  const flags = useMemo(() => (latest ? visible(latest.flags, now) : []), [latest, now])
  const rows = useMemo(() => (latest ? buildRows(latest.resources, flags) : []), [latest, flags])
  const selected = rows.find((row) => row.resource.key === selectedKey) ?? null
  const accountFlags = flags.filter((flag) => flag.resourceKey === null)

  async function scanNow() {
    setScanError(null)
    const result = await api().runScan()
    if (!result.ok) setScanError(result.error.message)
  }

  /** Left and right move between tabs, as in any tab strip. */
  function onTabKey(event: KeyboardEvent<HTMLButtonElement>) {
    const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0
    if (!step) return
    event.preventDefault()
    const next = TABS[(TABS.indexOf(tab) + step + TABS.length) % TABS.length]!
    setTab(next)
    tabRefs.current[next]?.focus()
  }

  if (error) {
    return (
      <main className="main-window">
        <h1>Cloud Watchdog</h1>
        <p role="alert">{error}</p>
      </main>
    )
  }
  if (!state) {
    return (
      <main className="main-window" aria-busy="true">
        <h1>Cloud Watchdog</h1>
        <p>Loading</p>
      </main>
    )
  }

  const summary = state.lastScan
  const tabLabel: Record<Tab, string> = {
    resources: summary ? `Resources (${summary.resourceCount})` : 'Resources',
    problems: summary && summary.errorCount > 0 ? `Scan problems (${summary.errorCount})` : 'Scan problems',
    settings: 'Settings'
  }

  return (
    <main className="main-window">
      <header className="main-header">
        <h1>Cloud Watchdog</h1>
        {state.identity && (
          <p className="identity">
            <span>Account {state.identity.accountId}</span>
            <span className="quiet" title={state.identity.arn}>
              signed in as {state.identity.arn.split(':').slice(5).join(':') || state.identity.arn} with profile {state.identity.profile}
            </span>
          </p>
        )}
        {state.settings.profile && (
          <div className="scan-status">
            <p className="quiet" aria-live="polite">
              {state.scanInProgress
                ? progress
                  ? `Scanning, ${progress.done} of ${progress.total}`
                  : 'Scanning'
                : summary
                  ? `Scanned ${formatAgo(summary.finishedAt, now)}`
                  : 'Not scanned yet'}
            </p>
            <button type="button" className="button-primary" onClick={scanNow} disabled={state.scanInProgress}>
              {state.scanInProgress ? 'Scanning' : 'Scan now'}
            </button>
          </div>
        )}
      </header>

      {scanError && <p role="alert">{scanError}</p>}
      <ProblemBanner problem={state.problem} />

      {!state.settings.profile ? (
        <FirstRun />
      ) : (
        <>
          {summary && (
            <>
              <PlanBanner plan={summary.plan} scanned />
              <section className="summary" aria-label="Summary">
                <BurnRateFigure burn={summary.burn} />
                <RunwayGauge runway={summary.runway} />
                <PlanFigure plan={summary.plan} />
              </section>
              {accountFlags.length > 0 && (
                <ul className="account-flags">
                  {accountFlags.map((flag) => (
                    <li key={flag.id} className="banner" data-tone={flag.severity === 'critical' ? 'critical' : 'info'}>
                      {flag.message}
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}

          <div role="tablist" aria-label="Sections" className="tabs">
            {TABS.map((name) => (
              <button
                key={name}
                ref={(element) => {
                  tabRefs.current[name] = element
                }}
                type="button"
                role="tab"
                id={`tab-${name}`}
                aria-selected={tab === name}
                aria-controls={`panel-${name}`}
                tabIndex={tab === name ? 0 : -1}
                onClick={() => setTab(name)}
                onKeyDown={onTabKey}
              >
                {tabLabel[name]}
              </button>
            ))}
          </div>

          <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`} className="tab-panel">
            {tab === 'resources' &&
              (latest ? (
                <div className="resources-layout" data-has-detail={selected !== null || undefined}>
                  <ResourceTable rows={rows} selectedKey={selectedKey} onSelect={setSelectedKey} />
                  {selected ? (
                    <DetailPanel
                      key={selected.resource.key}
                      resource={selected.resource}
                      flags={selected.flags}
                      canStop={state.settings.actionsEnabled}
                    />
                  ) : (
                    rows.length > 0 && <p className="detail-hint quiet">Choose a resource to see what it is, what it costs and what to do about it.</p>
                  )}
                </div>
              ) : (
                <p className="empty" aria-busy={state.scanInProgress}>
                  {state.scanInProgress ? 'The first scan is running. Every enabled region is checked, which takes a minute or so.' : 'No scan yet.'}
                </p>
              ))}
            {tab === 'problems' && (latest ? <ScanErrors errors={latest.errors} /> : <p className="empty">No scan yet.</p>)}
            {tab === 'settings' && <SettingsPanel key={JSON.stringify(state.settings)} settings={state.settings} />}
          </div>
        </>
      )}
    </main>
  )
}
