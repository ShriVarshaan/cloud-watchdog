// Choosing the AWS profile, on first run and in settings. After a profile is
// chosen the app shows who it signed in as, so the user can check it is the
// account they meant before trusting any number.

import { useEffect, useState, type FormEvent } from 'react'
import type { Identity } from '../../shared/types'
import { api } from '../api'

export function ProfilePicker({ current, onSelected }: { current: string | null; onSelected?: (identity: Identity) => void }) {
  const [profiles, setProfiles] = useState<string[] | null>(null)
  const [choice, setChoice] = useState(current ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void api()
      .listProfiles()
      .then((result) => {
        if (!result.ok) return setError(result.error.message)
        setProfiles(result.value)
        setChoice((existing) => existing || result.value[0] || '')
      })
  }, [])

  async function select(event: FormEvent) {
    event.preventDefault()
    if (!choice) return
    setBusy(true)
    setError(null)
    const result = await api().selectProfile({ profile: choice })
    setBusy(false)
    if (result.ok) onSelected?.(result.value)
    else setError(result.error.message)
  }

  if (profiles === null) return error ? <p role="alert">{error}</p> : <p aria-busy="true">Reading AWS profiles</p>
  if (profiles.length === 0) {
    return (
      <div className="banner" data-tone="info">
        <p>No AWS profiles were found on this computer.</p>
        <p>Set one up with the AWS CLI, for example with aws configure or aws configure sso, then reopen this window.</p>
      </div>
    )
  }

  return (
    <form className="profile-picker" onSubmit={select}>
      <label className="field">
        <span>Profile</span>
        <select value={choice} onChange={(e) => setChoice(e.target.value)}>
          {profiles.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
      </label>
      <button type="submit" className="button-primary" disabled={busy || !choice || choice === current}>
        {busy ? 'Signing In' : current ? 'Switch Profile' : 'Use This Profile'}
      </button>
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
    </form>
  )
}

export function FirstRun() {
  return (
    <section className="first-run" aria-labelledby="first-run-title">
      <h2 id="first-run-title">Choose the AWS account to watch</h2>
      <p className="quiet">
        Cloud Watchdog uses a profile you have already set up with the AWS CLI. It reads what is running in every enabled region, prices it, and warns
        you before forgotten resources use up your credits. It never stores your keys and never changes anything in your account.
      </p>
      <ProfilePicker current={null} />
    </section>
  )
}
