// What to do when there is no AWS profile on this computer yet: install the
// AWS CLI if it is missing, create a profile with it, then check again. The
// app never runs these commands; it shows them to copy.

import { useCallback, useEffect, useState, type ReactNode } from 'react'
import type { IpcResult } from '../../shared/ipc'
import type { AwsCliStatus, SetupGuide } from '../../shared/types'
import { api } from '../api'

/** A command to copy, with any other buttons for it on the same row. */
function Command({ text, label, children }: { text: string; label: string; children?: ReactNode }) {
  const [copied, setCopied] = useState<'yes' | 'failed' | null>(null)

  async function copy() {
    try {
      await navigator.clipboard.writeText(text)
      setCopied('yes')
    } catch {
      setCopied('failed')
    }
  }

  return (
    <>
      <pre className="command" tabIndex={0} aria-label={label}>
        <code>{text}</code>
      </pre>
      <p className="command-actions">
        <button type="button" className="button-quiet" onClick={copy}>
          Copy Command
        </button>
        {children}
        <span role="status">{copied === 'yes' ? 'Copied' : copied === 'failed' ? 'Could not copy. Select it and press Ctrl+C.' : ''}</span>
      </p>
    </>
  )
}

export interface SetupStepsViewProps {
  /** null until the check has answered. */
  cli: AwsCliStatus | null
  checking: boolean
  onCheckAgain(): void
  onOpenGuide(guide: SetupGuide): void
}

export function SetupStepsView({ cli, checking, onCheckAgain, onOpenGuide }: SetupStepsViewProps) {
  const guideButton = (guide: SetupGuide, label: string) => (
    <button type="button" className="button-quiet" onClick={() => onOpenGuide(guide)}>
      {label}
    </button>
  )

  return (
    <section className="setup" aria-labelledby="setup-title">
      <h3 id="setup-title">Set up access to your AWS account</h3>
      <p className="quiet">
        No AWS profiles were found on this computer. Setting one up with the AWS CLI takes a few minutes.
      </p>
      <ol className="setup-steps">
        <li data-done={cli?.installed || undefined}>
          <h4>Install the AWS CLI</h4>
          {cli === null ? (
            <p aria-busy="true">Checking for the AWS CLI…</p>
          ) : cli.installed ? (
            <p>Done: {cli.version ? `version ${cli.version} of the AWS CLI is installed.` : 'the AWS CLI is installed.'}</p>
          ) : (
            <>
              <p>The AWS CLI is not installed on this computer. Run the installer from AWS, or run this in a terminal:</p>
              <Command text="winget install --exact --id Amazon.AWSCLI" label="Command to install the AWS CLI">
                {guideButton('install-cli', 'Open the Install Guide…')}
              </Command>
            </>
          )}
        </li>
        <li>
          <h4>Create a profile</h4>
          <p>
            Choose one way. Give the IAM user or permission set the read-only policy from the Cloud Watchdog README, so the app can look but not
            change anything.
          </p>
          <p>
            <strong>With an access key</strong> for an IAM user: create the key in the IAM console, then run this and paste the key when asked.
          </p>
          <Command text="aws configure" label="Command to create a profile with an access key">
            {guideButton('access-keys', 'Open the Access Key Guide…')}
          </Command>
          <p>
            <strong>With IAM Identity Center</strong> (single sign-on), if your organisation uses it:
          </p>
          <Command text="aws configure sso" label="Command to create a single sign-on profile">
            {guideButton('sso', 'Open the Single Sign-On Guide…')}
          </Command>
        </li>
        <li>
          <h4>Check again</h4>
          <p>When the profile is saved, check again. Nothing needs restarting.</p>
          <p>
            <button type="button" className="button-primary" onClick={onCheckAgain} disabled={checking}>
              {checking ? 'Checking…' : 'Check Again'}
            </button>
          </p>
        </li>
      </ol>
    </section>
  )
}

/** The steps with their data: checks for the CLI on show and on "Check Again", which also re-reads the profiles. */
export function SetupSteps({ onReloadProfiles }: { onReloadProfiles(): Promise<void> }) {
  const [cli, setCli] = useState<AwsCliStatus | null>(null)
  const [checking, setChecking] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const showCli = useCallback((result: IpcResult<AwsCliStatus>) => {
    // Not knowing is shown as not installed: the steps to install it are still right.
    setCli(result.ok ? result.value : { installed: false, version: null })
  }, [])

  useEffect(() => {
    void api().checkAwsCli().then(showCli)
  }, [showCli])

  const checkCli = async () => showCli(await api().checkAwsCli())

  async function checkAgain() {
    setChecking(true)
    setError(null)
    await Promise.all([checkCli(), onReloadProfiles()])
    setChecking(false)
  }

  async function openGuide(guide: SetupGuide) {
    const result = await api().openSetupGuide({ guide })
    if (!result.ok) setError(result.error.message)
  }

  return (
    <>
      <SetupStepsView cli={cli} checking={checking} onCheckAgain={() => void checkAgain()} onOpenGuide={(guide) => void openGuide(guide)} />
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
    </>
  )
}
