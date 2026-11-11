// The Stop button for a running EC2 instance or an available RDS database.
// Shown only when stopping is switched on in Settings.
//
// Two steps, both decided in the main process:
//   1. "Stop this instance" asks the main process to look at it in AWS now.
//      It answers with what stopping means, or with the reasons it refuses.
//   2. "Stop instance" sends back the one-time token from step 1. The main
//      process then asks again in its own dialog before anything happens.
// This component only shows what it is told. It holds no rule of its own.

import { useState } from 'react'
import type { ActionKind, ActionPreview, PricedResource, ResourceKind } from '../../shared/types'
import { api } from '../api'

const STOPPABLE: Partial<Record<ResourceKind, { action: ActionKind; state: string; noun: string; title: string }>> = {
  'ec2-instance': { action: 'stop-ec2', state: 'running', noun: 'instance', title: 'Instance' },
  'rds-instance': { action: 'stop-rds', state: 'available', noun: 'database', title: 'Database' }
}

type Phase =
  | { step: 'idle' }
  | { step: 'checking' }
  | { step: 'preview'; preview: ActionPreview }
  | { step: 'confirming'; preview: ActionPreview }
  | { step: 'done'; message: string }

export function StopAction({ resource }: { resource: PricedResource }) {
  const [phase, setPhase] = useState<Phase>({ step: 'idle' })
  const [problem, setProblem] = useState<string | null>(null)

  const kind = STOPPABLE[resource.kind]
  if (!kind) return null
  // After a stop the message stays, although there is nothing left to stop.
  if (phase.step === 'done') return <p role="status">{phase.message}</p>
  if (resource.state !== kind.state) return null

  async function check() {
    setProblem(null)
    setPhase({ step: 'checking' })
    const result = await api().previewAction({ resourceKey: resource.key, action: kind!.action })
    if (result.ok) {
      setPhase({ step: 'preview', preview: result.value })
    } else {
      setProblem(result.error.message)
      setPhase({ step: 'idle' })
    }
  }

  async function stop(preview: ActionPreview) {
    if (!preview.token) return
    setProblem(null)
    setPhase({ step: 'confirming', preview })
    const result = await api().executeAction({ token: preview.token })
    if (result.ok) {
      setPhase({ step: 'done', message: result.value.message })
    } else {
      // The token is spent either way, so the next try starts with a new look at AWS.
      setProblem(result.error.message)
      setPhase({ step: 'idle' })
    }
  }

  if (phase.step === 'idle' || phase.step === 'checking') {
    return (
      <>
        <p>
          <button type="button" className="button-destructive" onClick={check} disabled={phase.step === 'checking'}>
            {phase.step === 'checking' ? 'Checking in AWS…' : `Stop This ${kind.title}`}
          </button>
        </p>
        {problem && <p role="alert">{problem}</p>}
      </>
    )
  }

  const { preview } = phase
  const confirming = phase.step === 'confirming'
  return (
    <div className="stop-preview" role="group" aria-label={`Stop this ${kind.noun}`}>
      {preview.blockers.length > 0 ? (
        <>
          <p>Cloud Watchdog will not stop this:</p>
          <ul>
            {preview.blockers.map((blocker) => (
              <li key={blocker}>{blocker}</li>
            ))}
          </ul>
          <p>You can still do it yourself, in the console or with the command below.</p>
          <p className="command-actions">
            <button type="button" className="button-quiet" onClick={() => setPhase({ step: 'idle' })}>
              Close
            </button>
          </p>
        </>
      ) : (
        <>
          <p>AWS says it is {preview.liveState}. If you stop it:</p>
          <ul>
            {preview.consequences.map((consequence) => (
              <li key={consequence}>{consequence}</li>
            ))}
          </ul>
          <p className="command-actions">
            {/* Destructive, so never the default (blue) button. The ellipsis says a confirmation window follows. */}
            <button type="button" className="button-destructive" onClick={() => stop(preview)} disabled={confirming}>
              Stop {kind.title}…
            </button>
            <button type="button" className="button-quiet" onClick={() => setPhase({ step: 'idle' })} disabled={confirming}>
              Cancel
            </button>
          </p>
          <p className="quiet" role="status">
            {confirming
              ? 'Answer in the confirmation window.'
              : 'Cloud Watchdog asks once more before it stops anything. Use the button within a minute.'}
          </p>
        </>
      )}
    </div>
  )
}
