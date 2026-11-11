// The text of the two confirmation dialogs that stand between the UI and a
// change in AWS. The dialogs are native and shown by the main process
// (index.ts), so the page can neither draw them nor answer them. The text is
// built here from the main process's own data, never from anything the page sent.

import type { Confirmation } from '../core/actions/guard'
import type { ActionKind, Identity } from '../shared/types'

export interface ConfirmDialog {
  /** The question, in one line. */
  message: string
  /** Everything the user should know before answering. */
  detail: string
  /** The button that says yes. The other button is always "Cancel", and is the default. */
  confirmLabel: string
}

const WHAT: Record<ActionKind, { thing: string; button: string }> = {
  'stop-ec2': { thing: 'EC2 instance', button: 'Stop instance' },
  'stop-rds': { thing: 'RDS database', button: 'Stop database' }
}

export function stopConfirmation(confirmation: Confirmation): ConfirmDialog {
  const { thing, button } = WHAT[confirmation.action]
  const which = confirmation.name ? `"${confirmation.name}" (${confirmation.id})` : confirmation.id
  return {
    message: `Stop the ${thing} ${which}?`,
    detail: [
      `Account ${confirmation.accountId}, signed in with profile ${confirmation.profile}`,
      `Region ${confirmation.region}`,
      '',
      'If you stop it:',
      ...confirmation.consequences.map((consequence) => `• ${consequence}`),
      '',
      'Nothing is deleted.'
    ].join('\n'),
    confirmLabel: button
  }
}

export function enableActionsConfirmation(identity: Identity): ConfirmDialog {
  return {
    message: 'Let Cloud Watchdog stop EC2 instances and RDS databases?',
    detail: [
      `Account ${identity.accountId}, signed in with profile ${identity.profile}`,
      '',
      'A Stop button appears on running instances and available databases. Each stop first shows what it means, and asks again before anything happens. Cloud Watchdog never deletes or terminates anything, and it cannot start what it stopped.',
      '',
      'The profile also needs the extra IAM policy in iam/cloud-watchdog-actions.json. It allows ec2:StopInstances and rds:StopDBInstance. Without it, AWS refuses the stop.',
      '',
      'This is switched off again when you choose another profile.'
    ].join('\n'),
    confirmLabel: 'Switch on'
  }
}
