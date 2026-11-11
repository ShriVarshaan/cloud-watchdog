// One resource: what it is, why it costs money, what the rate leaves out,
// its warnings, and what to do about it (console link, command to copy, and
// the Stop button when stopping is switched on).

import { useEffect, useState } from 'react'
import { KIND_EXPLANATIONS } from '../../shared/explain'
import { formatUsdPerMonth } from '../../shared/format'
import type { Flag, ManualSteps, PricedResource } from '../../shared/types'
import { api } from '../api'
import { CONFIDENCE_EXPLANATION, CoverageBadge, PriceBadge, SeverityMark } from '../components/Badges'
import { StopAction } from './StopAction'

const COVERAGE_TEXT = {
  covered: 'Credits or the free tier pay for this right now.',
  'not-covered': 'You pay for this.',
  unknown: 'Not known whether credits or the free tier pay for this.'
} as const

export function DetailPanel({ resource, flags, canStop }: { resource: PricedResource; flags: Flag[]; canStop: boolean }) {
  const kind = KIND_EXPLANATIONS[resource.kind]
  const [steps, setSteps] = useState<ManualSteps | null>(null)
  const [stepsError, setStepsError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)

  // MainWindow keys this component by resource, so every resource starts with fresh state.
  useEffect(() => {
    let live = true
    void api()
      .getManualSteps({ resourceKey: resource.key })
      .then((result) => {
        if (!live) return
        if (result.ok) setSteps(result.value)
        else setStepsError(result.error.message)
      })
    return () => {
      live = false
    }
  }, [resource.key])

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
    } catch {
      setActionError('Could not copy. Select the command and copy it with Ctrl+C.')
    }
  }

  async function openConsole() {
    const result = await api().openConsole({ resourceKey: resource.key })
    if (!result.ok) setActionError(result.error.message)
  }

  async function dismiss(flagId: string, hours?: number) {
    const result = await api().dismissFlag(hours === undefined ? { flagId } : { flagId, hours })
    if (!result.ok) setActionError(result.error.message)
  }

  const { price } = resource
  return (
    <aside className="detail" aria-labelledby="detail-title">
      <header>
        <p className="quiet">{kind.name}</p>
        <h2 id="detail-title">{resource.name ?? resource.id}</h2>
        {resource.name && <p className="quiet">{resource.id}</p>}
        <p className="quiet">
          {resource.region}, {resource.state}
        </p>
      </header>

      {resource.stale && (
        <p className="banner" data-tone="info">
          The last scan could not look at this region, so this is the data from an earlier scan.
        </p>
      )}

      <section aria-labelledby="detail-cost">
        <h3 id="detail-cost">Cost</h3>
        <p className="detail-price">
          <PriceBadge price={price} />
        </p>
        {price.hourlyUsd !== null && price.hourlyUsd > 0 && <p>That is {formatUsdPerMonth(price.hourlyUsd)} if it keeps running.</p>}
        <p>{CONFIDENCE_EXPLANATION[price.confidence]}</p>
        {price.excluded.length > 0 && (
          <>
            <p>Not included in this rate:</p>
            <ul>
              {price.excluded.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </>
        )}
        <p>
          <CoverageBadge coverage={resource.coverage} /> {COVERAGE_TEXT[resource.coverage]}
        </p>
      </section>

      <section aria-labelledby="detail-what">
        <h3 id="detail-what">What this is</h3>
        <p>{kind.what}</p>
        <p>{kind.cost}</p>
      </section>

      {flags.length > 0 && (
        <section aria-labelledby="detail-flags">
          <h3 id="detail-flags">Warnings</h3>
          <ul className="flag-list">
            {flags.map((flag) => (
              <li key={flag.id}>
                <SeverityMark severity={flag.severity} />
                <span>{flag.message}</span>
                <span className="flag-actions">
                  <button type="button" className="button-quiet" onClick={() => dismiss(flag.id, 24)}>
                    Hide for a day
                  </button>
                  <button type="button" className="button-quiet" onClick={() => dismiss(flag.id)}>
                    Hide until fixed
                  </button>
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section aria-labelledby="detail-steps">
        <h3 id="detail-steps">What you can do</h3>
        {canStop && <StopAction resource={resource} />}
        {stepsError && <p role="alert">{stepsError}</p>}
        {steps && (
          <>
            <p>
              <button type="button" className="button-primary" onClick={openConsole}>
                Open in the AWS console
              </button>
            </p>
            {steps.cliCommand ? (
              <>
                <p>Or run this with the AWS CLI. Cloud Watchdog never runs it for you.</p>
                <pre className="command" tabIndex={0} aria-label="AWS CLI command">
                  <code>{steps.cliCommand}</code>
                </pre>
                <p className="command-actions">
                  <button type="button" className="button-quiet" onClick={() => copy(steps.cliCommand!)}>
                    Copy command
                  </button>
                  <span role="status">{copied ? 'Copied' : ''}</span>
                </p>
                {steps.cliNote && <p className="note">{steps.cliNote}</p>}
              </>
            ) : (
              <p>There is no single safe command for this. Check it in the console.</p>
            )}
          </>
        )}
        {actionError && <p role="alert">{actionError}</p>}
      </section>
    </aside>
  )
}
