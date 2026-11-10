// The AWS profile, how often to scan, notifications, start at login, and the rules.

import { useState, type FormEvent } from 'react'
import { RULE_INFO } from '../../shared/explain'
import { SCAN_INTERVAL_MINUTES, type RuleSetting, type Settings } from '../../shared/types'
import { api } from '../api'
import { ProfilePicker } from './FirstRun'

type Draft = Pick<Settings, 'scanIntervalMinutes' | 'notificationsEnabled' | 'startAtLogin' | 'rules'>

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
      <section aria-labelledby="settings-profile">
        <h2 id="settings-profile">AWS profile</h2>
        <p>The profile from your AWS CLI setup that Cloud Watchdog signs in with. Its keys never leave the AWS configuration files.</p>
        <ProfilePicker current={settings.profile} />
      </section>

      <form onSubmit={save} aria-labelledby="settings-scanning">
        <h2 id="settings-scanning">Scanning and alerts</h2>
        <label className="field">
          <span>Scan every</span>
          <input
            type="number"
            min={SCAN_INTERVAL_MINUTES.min}
            max={SCAN_INTERVAL_MINUTES.max}
            required
            value={draft.scanIntervalMinutes}
            onChange={(e) => setDraft({ ...draft, scanIntervalMinutes: e.target.valueAsNumber })}
          />
          <span>minutes</span>
        </label>
        <label className="check">
          <input type="checkbox" checked={draft.notificationsEnabled} onChange={(e) => setDraft({ ...draft, notificationsEnabled: e.target.checked })} />
          Show a Windows notification for each new warning
        </label>
        <label className="check">
          <input type="checkbox" checked={draft.startAtLogin} onChange={(e) => setDraft({ ...draft, startAtLogin: e.target.checked })} />
          Start Cloud Watchdog when I sign in to Windows
        </label>

        <h3>Warnings</h3>
        <ul className="rule-list">
          {Object.entries(RULE_INFO).map(([id, info]) => {
            const rule = draft.rules[id]!
            return (
              <li key={id}>
                <label className="check">
                  <input type="checkbox" checked={rule.enabled} onChange={(e) => setRule(id, { enabled: e.target.checked })} />
                  <span>
                    <span className="rule-name">{info.label}</span>
                    <span className="quiet"> {info.description}</span>
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
                    <span>{param.unit}</span>
                  </label>
                ))}
              </li>
            )
          })}
        </ul>

        <p className="form-actions">
          <button type="submit" className="button-primary">
            Save settings
          </button>
          <span role="status" data-tone={status?.tone}>
            {status?.text ?? ''}
          </span>
        </p>
      </form>
    </div>
  )
}
