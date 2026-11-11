import { describe, expect, it } from 'vitest'
import { enableActionsConfirmation, stopConfirmation } from './confirmations'

const base = {
  accountId: '111122223333',
  profile: 'hackathon',
  region: 'eu-west-1',
  consequences: ['Its disks keep billing.', 'It gets a different address.']
}

describe('the confirmation before a stop', () => {
  it('names the instance, its region and the account, and lists what stopping means', () => {
    const dialog = stopConfirmation({ ...base, action: 'stop-ec2', id: 'i-0abc', name: 'web' })
    expect(dialog.message).toBe('Stop the EC2 instance "web" (i-0abc)?')
    expect(dialog.detail).toContain('Account 111122223333, signed in with profile hackathon')
    expect(dialog.detail).toContain('Region eu-west-1')
    expect(dialog.detail).toContain('• Its disks keep billing.\n• It gets a different address.')
    expect(dialog.confirmLabel).toBe('Stop instance')
  })

  it('uses the id alone for an instance without a name', () => {
    expect(stopConfirmation({ ...base, action: 'stop-ec2', id: 'i-0abc', name: null }).message).toBe('Stop the EC2 instance i-0abc?')
  })

  it('speaks of a database for RDS', () => {
    const dialog = stopConfirmation({ ...base, action: 'stop-rds', id: 'shop-db', name: null })
    expect(dialog.message).toBe('Stop the RDS database shop-db?')
    expect(dialog.confirmLabel).toBe('Stop database')
  })
})

describe('the confirmation before stopping is switched on', () => {
  it('names the account, the profile and the extra policy with the two permissions it grants', () => {
    const dialog = enableActionsConfirmation({ accountId: '111122223333', arn: 'arn:aws:iam::111122223333:user/watchdog', profile: 'hackathon' })
    const text = `${dialog.message}\n${dialog.detail}`
    expect(text).toContain('111122223333')
    expect(text).toContain('hackathon')
    expect(text).toContain('iam/cloud-watchdog-actions.json')
    expect(text).toContain('ec2:StopInstances')
    expect(text).toContain('rds:StopDBInstance')
  })
})
