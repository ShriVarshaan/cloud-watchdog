// The main window, laid out like a macOS utility (docs/DESIGN.md): a sidebar
// with three sections (resources with the inspector, scan problems,
// settings), and a toolbar with the section title, the account as its
// subtitle, and Scan Now. The sidebar is a vertical tab list, so screen readers and the keyboard
// treat it the way they treated the old tab strip.

import { Boxes, RefreshCw, Settings as SettingsGlyph, TriangleAlert, type LucideIcon } from 'lucide-react'
import { useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { formatAgo } from '../../shared/format'
import type { Flag } from '../../shared/types'
import { api, useAppState, useLatestScan, useNow, useScanProgress } from '../api'
import { PlanBanner, ProblemBanner } from '../components/Banners'
import { Icon } from '../components/Icon'
import { BurnRateFigure, PlanFigure, RunwayGauge } from '../components/Summary'
import { DetailPanel } from './DetailPanel'
import { FirstRun } from './FirstRun'
import { buildRows, ResourceTable } from './ResourceTable'
import { ScanErrors } from './ScanErrors'
import { SettingsPanel } from './SettingsPanel'

type Tab = 'resources' | 'problems' | 'settings'
const TABS: Tab[] = ['resources', 'problems', 'settings']
const TAB_TITLE: Record<Tab, string> = { resources: 'Resources', problems: 'Scan Problems', settings: 'Settings' }
const TAB_ICON: Record<Tab, LucideIcon> = { resources: Boxes, problems: TriangleAlert, settings: SettingsGlyph }
const NEXT_KEYS: Record<string, number> = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }

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

  /** The arrow keys move between sections, either way round. */
  function onTabKey(event: KeyboardEvent<HTMLButtonElement>) {
    const step = NEXT_KEYS[event.key]
    if (!step) return
    event.preventDefault()
    const next = TABS[(TABS.indexOf(tab) + step + TABS.length) % TABS.length]!
    setTab(next)
    tabRefs.current[next]?.focus()
  }

  if (error || !state) {
    return (
      <main className="welcome" aria-busy={!error || undefined}>
        <div className="welcome-toolbar" />
        <div className="welcome-card">
          <h1>Cloud Watchdog</h1>
          {error ? <p role="alert">{error}</p> : <p className="quiet">Loading…</p>}
        </div>
      </main>
    )
  }

  if (!state.settings.profile) {
    return (
      <main className="welcome">
        <div className="welcome-toolbar" />
        <div className="welcome-card">
          <h1>Cloud Watchdog</h1>
          <ProblemBanner problem={state.problem} />
          <FirstRun />
        </div>
      </main>
    )
  }

  const summary = state.lastScan
  const count: Record<Tab, number | undefined> = {
    resources: summary?.resourceCount,
    problems: summary && summary.errorCount > 0 ? summary.errorCount : undefined,
    settings: undefined
  }
  const scanStatus = state.scanInProgress
    ? progress
      ? `Scanning, ${progress.done} of ${progress.total}…`
      : 'Scanning…'
    : summary
      ? `Scanned ${formatAgo(summary.finishedAt, now)}`
      : 'Not scanned yet'

  return (
    <div className="main-window" data-section={tab}>
      <div className="sidebar">
        <div className="sidebar-head">
          <h1>Cloud Watchdog</h1>
        </div>
        <nav aria-label="Sections">
          <div role="tablist" aria-label="Sections" aria-orientation="vertical" className="sidebar-list">
            {TABS.map((name) => {
              const n = count[name]
              const label = n === undefined ? TAB_TITLE[name] : `${TAB_TITLE[name]} (${n})`
              return (
                <button
                  key={name}
                  ref={(element) => {
                    tabRefs.current[name] = element
                  }}
                  type="button"
                  role="tab"
                  id={`tab-${name}`}
                  aria-label={label}
                  aria-selected={tab === name}
                  aria-controls={`panel-${name}`}
                  tabIndex={tab === name ? 0 : -1}
                  onClick={() => setTab(name)}
                  onKeyDown={onTabKey}
                  title={label}
                >
                  <Icon icon={TAB_ICON[name]} />
                  <span className="sidebar-label">{TAB_TITLE[name]}</span>
                  {n !== undefined && <span className="sidebar-count">{n}</span>}
                </button>
              )
            })}
          </div>
        </nav>
      </div>

      <main className="content">
        <header className="main-header">
          <div className="toolbar-titles">
            <h2 className="toolbar-title">{TAB_TITLE[tab]}</h2>
            {/* The window subtitle: which account this is, visible at every width. */}
            {state.identity && (
              <p className="identity">
                <span>Account {state.identity.accountId}</span>
                <span className="quiet" title={state.identity.arn}>
                  {state.identity.arn.split(':').slice(5).join(':') || state.identity.arn}, profile {state.identity.profile}
                </span>
              </p>
            )}
          </div>
          <p className="toolbar-status quiet" aria-live="polite">
            {scanStatus}
          </p>
          <button type="button" className="button-quiet toolbar-scan" onClick={scanNow} disabled={state.scanInProgress}>
            <span className="scan-glyph" data-spinning={state.scanInProgress || undefined}>
              <Icon icon={RefreshCw} />
            </span>
            {state.scanInProgress ? 'Scanning…' : 'Scan Now'}
          </button>
        </header>

        <div className="content-body">
          {(scanError || state.problem || summary) && (
            <div className="notices">
              {scanError && (
                <p className="banner" data-tone="critical" role="alert">
                  {scanError}
                </p>
              )}
              <ProblemBanner problem={state.problem} />
              {summary && <PlanBanner plan={summary.plan} scanned />}
            </div>
          )}

          <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`} className="tab-panel">
            {tab === 'resources' && (
              <>
                {summary && (
                  <>
                    <section className="summary" aria-label="Summary">
                      <RunwayGauge runway={summary.runway} />
                      <BurnRateFigure burn={summary.burn} />
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
                {latest ? (
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
                      rows.length > 0 && (
                        <p className="detail-hint quiet">Choose a resource to see what it is, what it costs and what to do about it.</p>
                      )
                    )}
                  </div>
                ) : (
                  <p className="empty" aria-busy={state.scanInProgress}>
                    {state.scanInProgress
                      ? 'The first scan is running. Every enabled region is checked, which takes a minute or so.'
                      : 'No scan yet.'}
                  </p>
                )}
              </>
            )}
            {tab === 'problems' && (latest ? <ScanErrors errors={latest.errors} /> : <p className="empty">No scan yet.</p>)}
            {tab === 'settings' && <SettingsPanel key={JSON.stringify(state.settings)} settings={state.settings} />}
          </div>
        </div>
      </main>
    </div>
  )
}
