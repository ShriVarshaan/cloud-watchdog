// What the app is able to do in an AWS account, read from its source code.
//
// Every AWS SDK command or paginator imported anywhere under src/ is turned
// into its IAM action. Three things must then hold:
//
//   1. the app imports only read-only calls (Describe*, Get*, List*)
//   2. every call it imports is granted by iam/cloud-watchdog-readonly.json
//   3. the policy grants nothing the app does not use
//
// So adding a call without updating the policy fails here, and so does
// importing anything that could change or delete something. When the stop
// actions arrive (M10) they get their own, explicit allow-list.

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const SRC = join(import.meta.dirname, '..', '..', 'src')
const POLICY = join(import.meta.dirname, '..', '..', 'iam', 'cloud-watchdog-readonly.json')

/** SDK package -> IAM service prefix. An unknown package fails the test. */
const IAM_PREFIX: Record<string, string> = {
  'client-sts': 'sts',
  'client-ec2': 'ec2',
  'client-rds': 'rds',
  'client-elastic-load-balancing': 'elasticloadbalancing',
  'client-elastic-load-balancing-v2': 'elasticloadbalancing',
  'client-sagemaker': 'sagemaker',
  'client-pricing': 'pricing',
  'client-freetier': 'freetier',
  'client-cloudwatch': 'cloudwatch'
}

/** Needs no IAM permission, so it is not in the policy. */
const NO_PERMISSION_NEEDED = ['sts:GetCallerIdentity']

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : []
  })
}

/** IAM actions of every command and paginator imported from the AWS SDK, with the files that import them. */
function importedActions(): Map<string, string[]> {
  const actions = new Map<string, string[]>()
  const imports = /import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+'@aws-sdk\/(client-[a-z0-9-]+)'/g

  for (const file of sourceFiles(SRC)) {
    const text = readFileSync(file, 'utf8')
    for (const [, names, pkg] of text.matchAll(imports)) {
      const prefix = IAM_PREFIX[pkg!]
      if (!prefix) throw new Error(`${file} imports @aws-sdk/${pkg}, which this test does not know. Add it to IAM_PREFIX.`)
      for (const item of names!.split(',')) {
        // "X as Y" imports X. "type X" is a type, not a call.
        const name = item.trim().split(/\s+as\s+/)[0]!.trim()
        if (!name || name.startsWith('type ')) continue
        const operation = /^paginate(\w+)$/.exec(name)?.[1] ?? /^(\w+)Command$/.exec(name)?.[1]
        if (!operation) continue
        const action = `${prefix}:${operation}`
        actions.set(action, [...(actions.get(action) ?? []), file.slice(SRC.length + 1)])
      }
    }
  }
  return actions
}

function policyActions(): string[] {
  const policy = JSON.parse(readFileSync(POLICY, 'utf8')) as { Statement: { Effect: string; Action: string[] }[] }
  return policy.Statement.flatMap((statement) => statement.Action)
}

describe('AWS calls in the source', () => {
  const used = importedActions()

  it('finds the calls (the scan of the source works)', () => {
    expect(used.has('ec2:DescribeInstances')).toBe(true)
    expect(used.size).toBeGreaterThanOrEqual(15)
  })

  it('are all read-only: nothing that creates, changes, stops or deletes', () => {
    const notReadOnly = [...used].filter(([action]) => !/^[a-z0-9]+:(Describe|Get|List)[A-Z]/.test(action))
    expect(notReadOnly).toEqual([])
  })

  it('are all granted by the read-only IAM policy', () => {
    const granted = new Set([...policyActions(), ...NO_PERMISSION_NEEDED])
    const missing = [...used.keys()].filter((action) => !granted.has(action)).sort()
    expect(missing).toEqual([])
  })

  it('use everything the policy grants: no permission is asked for that the app does not need', () => {
    const unused = policyActions().filter((action) => !used.has(action)).sort()
    expect(unused).toEqual([])
  })
})

describe('the read-only IAM policy', () => {
  it('only allows, and only read-only actions, with no wildcard actions', () => {
    const policy = JSON.parse(readFileSync(POLICY, 'utf8')) as { Statement: { Effect: string; Action: string[] }[] }
    expect(policy.Statement.every((statement) => statement.Effect === 'Allow')).toBe(true)
    expect(policyActions().filter((action) => !/^[a-z0-9]+:(Describe|Get|List)[A-Z][A-Za-z]+$/.test(action))).toEqual([])
  })
})
