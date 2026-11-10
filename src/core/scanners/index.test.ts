import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ALL_SCANNERS } from './index'

interface Policy {
  Statement: { Effect: string; Action: string[]; Resource: string | string[] }[]
}

const policy = JSON.parse(
  readFileSync(join(process.cwd(), 'iam', 'cloud-watchdog-readonly.json'), 'utf8')
) as Policy
const allowed = new Set(policy.Statement.filter((s) => s.Effect === 'Allow').flatMap((s) => s.Action))

describe('scanners and the read-only IAM policy', () => {
  it.each(ALL_SCANNERS.map((scanner) => [scanner.kind, scanner] as const))(
    '%s: every IAM action it needs is in iam/cloud-watchdog-readonly.json',
    (_kind, scanner) => {
      expect(scanner.requiredActions.length).toBeGreaterThan(0)
      expect(scanner.requiredActions.filter((action) => !allowed.has(action))).toEqual([])
    }
  )

  it('the policy allows listing regions, which the engine does itself', () => {
    expect(allowed.has('ec2:DescribeRegions')).toBe(true)
  })

  it('the policy grants read calls only', () => {
    const notReadOnly = [...allowed].filter((action) => !/^[a-z0-9-]+:(Describe|List|Get)[A-Za-z]+$/.test(action))
    expect(notReadOnly).toEqual([])
  })

  it('has at most one scanner per resource kind, so (kind, region) identifies a task', () => {
    const kinds = ALL_SCANNERS.map((scanner) => scanner.kind)
    expect(new Set(kinds).size).toBe(kinds.length)
  })

  it('includes the EC2 and RDS instance scanners', () => {
    expect(ALL_SCANNERS.map((scanner) => scanner.kind)).toEqual(
      expect.arrayContaining(['ec2-instance', 'rds-instance'])
    )
  })
})
