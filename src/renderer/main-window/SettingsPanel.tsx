// The AWS profile, how often to scan, notifications, start at login, the
// rules, and the switch for stopping. That switch is not part of the form:
// the main process asks in its own dialog before it turns it on.
//
// Laid out as grouped forms, as in macOS System Settings (docs/DESIGN.md):
// single on/off settings are switches; rules, which have settings of their
// own, are checkboxes; stopping is a push button because it opens a dialog.

import { useState, type FormEvent } from 'react'
import { RULE_INFO } from '../../shared/explain'
import { SCAN_INTERVAL_MINUTES, type RuleSetting, type Settings } from '../../shared/types'
import { api } from '../api'
import { ProfilePicker } from './FirstRun'

type Draft = Pick<Settings, 'scanIntervalMinutes' | 'notificationsEnabled' | 'startAtLogin' | 'rules'>

function StoppingSwitch({ settings }: { settings: Settings }) {
  const [problem, setProblem] = useState<string | null>(null)
  const [waiting, setWaiting] = useState(false)

  async function set(enabled: boolean) {
    setProblem(null)
    setWaiting(true)
    const result = await api().setActionsEnabled({ enabled })
    setWaiting(false)
    if (!result.ok) setProblem(result.error.message)
  }

  return (
    <section className="settings-section" aria-labelledby="settings-stopping">
      <h3 id="settings-stopping">Stopping instances and databases</h3>
      <div className="group">
        {settings.actionsEnabled ? (
          <div className="group-row">
            <p>
              On for the profile {settings.profile}. Running EC2 instances and available RDS databases have a Stop button. Each stop shows what it
              means and asks again first.
            </p>
            <button type="button" className="button-quiet" onClick={() => set(false)} disabled={waiting}>
              Switch Off Stopping
            </button>
          </div>
        ) : (
          <div className="group-row">
            <div>
              <p>Off. Cloud Watchdog only looks at your account and changes nothing in it.</p>
              <p className="group-note">
                Switched on, it can stop a running EC2 instance or an available RDS database when you ask it to. It never deletes anything. The
                profile then also needs the IAM policy in iam/cloud-watchdog-actions.json.
              </p>
            </div>
            <button type="button" className="button-quiet" onClick={() => set(true)} disabled={waiting}>
              Switch On Stopping…
            </button>
          </div>
        )}
      </div>
      {problem && (
        <p role="alert" className="form-error">
          {problem}
        </p>
      )}
    </section>
  )
}

function ruleDraft(settings: Settings, id: string): RuleSetting {
  const info = RULE_INFO[id]!
  const saved = settings.rules[id]
  const params = Object.fromEntries(Object.entries(info.params).map(([name, p]) => [name, saved?.params[name] ?? p.default]))
  return { enabled: saved?.enabled ?? true, params }
}

function toDraft(settings: Settings): Draft {
  return {
    scanIntervalMinutes: settings.scanIntervalMinutes,
    notificationsEnabled: settings.notificationsEnabled,
    startAtLogin: settings.startAtLogin,
    rules: Object.fromEntries(Object.keys(RULE_INFO).map((id) => [id, ruleDraft(settings, id)]))
  }
}

/** MainWindow keys this component by the saved settings, so the form restarts from them when they change. */
export function SettingsPanel({ settings }: { settings: Settings }) {
  const [draft, setDraft] = useState<Draft>(() => toDraft(settings))
  const [status, setStatus] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null)

  const setRule = (id: string, change: Partial<RuleSetting>) =>
    setDraft((current) => ({ ...current, rules: { ...current.rules, [id]: { ...current.rules[id]!, ...change } } }))

  async function save(event: FormEvent) {
    event.preventDefault()
    setStatus(null)
    const result = await api().updateSettings(draft)
    setStatus(result.ok ? { tone: 'ok', text: 'Settings saved.' } : { tone: 'error', text: result.error.message })
  }

  return (
    <div className="settings">
      <section className="settings-section" aria-labelledby="settings-profile">
        <h3 id="settings-profile">AWS profile</h3>
        <div className="group">
          <div className="group-row group-row-stacked">
            <p className="group-note">
              The profile from your AWS CLI setup that Cloud Watchdog signs in with. Its keys never leave the AWS configuration files.
            </p>
            <ProfilePicker current={settings.profile} />
          </div>
        </div>
      </section>

      <StoppingSwitch settings={settings} />

      <form className="settings-section" onSubmit={save} aria-labelledby="settings-scanning">
        <h3 id="settings-scanning">Scanning and alerts</h3>
        <div className="group">
          <label className="group-row">
            <span>Scan every</span>
            <span className="field">
              <input
                type="number"
                min={SCAN_INTERVAL_MINUTES.min}
                max={SCAN_INTERVAL_MINUTES.max}
                required
                value={draft.scanIntervalMinutes}
                onChange={(e) => setDraft({ ...draft, scanIntervalMinutes: e.target.valueAsNumber })}
              />
              <span className="quiet">minutes</span>
            </span>
          </label>
          <label className="group-row">
            <span>Show a Windows notification for each new warning</span>
            <input
              type="checkbox"
              role="switch"
              checked={draft.notificationsEnabled}
              onChange={(e) => setDraft({ ...draft, notificationsEnabled: e.target.checked })}
            />
          </label>
          <label className="group-row">
            <span>Start Cloud Watchdog when I sign in to Windows</span>
            <input
              type="checkbox"
              role="switch"
              checked={draft.startAtLogin}
              onChange={(e) => setDraft({ ...draft, startAtLogin: e.target.checked })}
            />
          </label>
        </div>

        <h4>Warnings</h4>
        <ul className="group rule-list">
          {Object.entries(RULE_INFO).map(([id, info]) => {
            const rule = draft.rules[id]!
            return (
              <li key={id} className="group-row group-row-stacked">
                <label className="check">
                  <input type="checkbox" checked={rule.enabled} onChange={(e) => setRule(id, { enabled: e.target.checked })} />
                  <span>
                    <span className="rule-name">{info.label}</span>
                    <span className="group-note"> {info.description}</span>
                  </span>
                </label>
                {Object.entries(info.params).map(([name, param]) => (
                  <label key={name} className="field indent">
                    <span>{param.label}</span>
                    <input
                      type="number"
                      min={0.1}
                      step="any"
                      required
                      disabled={!rule.enabled}
                      value={rule.params[name]}
                      onChange={(e) => setRule(id, { params: { ...rule.params, [name]: e.target.valueAsNumber } })}
                    />
                    <span className="quiet">{param.unit}</span>
                  </label>
                ))}
              </li>
            )
          })}
        </ul>

        <p className="form-actions">
          <span role="status" data-tone={status?.tone}>
            {status?.text ?? ''}
          </span>
          <button type="submit" className="button-primary">
            Save Settings
          </button>
        </p>
      </form>
    </div>
  )
}
