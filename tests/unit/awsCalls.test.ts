// What the app is able to do in an AWS account, read from its source code.
//
// Every AWS SDK command or paginator imported anywhere under src/ is turned
// into its IAM action. Then:
//
//   1. the only calls that change anything are ec2:StopInstances and
//      rds:StopDBInstance, and each is imported by its own driver and by
//      nothing else (the fake AWS account answers them, and never sends one)
//   2. everything else is read-only (Describe*, Get*, List*)
//   3. every call is granted by one of the two IAM policies
//   4. the policies grant nothing the app does not use
//
// So adding a call without updating a policy fails here, and so does
// importing anything else that could change or delete something.

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = join(import.meta.dirname, '..', '..')
const SRC = join(ROOT, 'src')
const READ_ONLY_POLICY = join(ROOT, 'iam', 'cloud-watchdog-readonly.json')
const ACTIONS_POLICY = join(ROOT, 'iam', 'cloud-watchdog-actions.json')

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

/** Needs no IAM permission, so it is in neither policy. */
const NO_PERMISSION_NEEDED = ['sts:GetCallerIdentity']

/**
 * The complete list of calls that change something, with the only files
 * allowed to import each. fakeAws.ts imports them to recognise and answer
 * them in the pretend account; it has no way to send one to AWS.
 */
const WRITE_CALLS: Record<string, string[]> = {
  'ec2:StopInstances': ['core/actions/stopEc2.ts', 'main/fakeAws.ts'],
  'rds:StopDBInstance': ['core/actions/stopRds.ts', 'main/fakeAws.ts']
}

const READ_ONLY = /^[a-z0-9]+:(Describe|Get|List)[A-Z][A-Za-z]+$/

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
        actions.set(action, [...(actions.get(action) ?? []), file.slice(SRC.length + 1).replaceAll('\\', '/')])
      }
    }
  }
  return actions
}

interface Statement {
  Sid: string
  Effect: string
  Action: string[]
  Resource: string | string[]
}
const statements = (path: string) => (JSON.parse(readFileSync(path, 'utf8')) as { Statement: Statement[] }).Statement
const actionsOf = (path: string) => statements(path).flatMap((statement) => statement.Action)

describe('AWS calls in the source', () => {
  const used = importedActions()

  it('finds the calls (the scan of the source works)', () => {
    expect(used.has('ec2:DescribeInstances')).toBe(true)
    expect(used.size).toBeGreaterThanOrEqual(15)
  })

  it('change something in exactly two ways: stopping an instance and stopping a database', () => {
    const notReadOnly = [...used.keys()].filter((action) => !READ_ONLY.test(action)).sort()
    expect(notReadOnly).toEqual(Object.keys(WRITE_CALLS).sort())
  })

  it.each(Object.entries(WRITE_CALLS))('%s is imported only by its driver and the fake account', (action, allowed) => {
    expect([...(used.get(action) ?? [])].sort()).toEqual([...allowed].sort())
  })

  it('are all granted by one of the two IAM policies', () => {
    const granted = new Set([...actionsOf(READ_ONLY_POLICY), ...actionsOf(ACTIONS_POLICY), ...NO_PERMISSION_NEEDED])
    const missing = [...used.keys()].filter((action) => !granted.has(action)).sort()
    expect(missing).toEqual([])
  })

  it('use everything the policies grant: no permission is asked for that the app does not need', () => {
    const unused = [...actionsOf(READ_ONLY_POLICY), ...actionsOf(ACTIONS_POLICY)].filter((action) => !used.has(action)).sort()
    expect(unused).toEqual([])
  })
})

describe('the read-only IAM policy', () => {
  it('only allows, and only read-only actions, with no wildcard actions', () => {
    expect(statements(READ_ONLY_POLICY).every((statement) => statement.Effect === 'Allow')).toBe(true)
    expect(actionsOf(READ_ONLY_POLICY).filter((action) => !READ_ONLY.test(action))).toEqual([])
  })
})

describe('the actions IAM policy', () => {
  it('allows the two stop calls and nothing else that changes anything', () => {
    expect(statements(ACTIONS_POLICY).every((statement) => statement.Effect === 'Allow')).toBe(true)
    expect(
      actionsOf(ACTIONS_POLICY)
        .filter((action) => !READ_ONLY.test(action))
        .sort()
    ).toEqual(['ec2:StopInstances', 'rds:StopDBInstance'])
  })

  it('limits the stop calls to instances and databases, not every resource', () => {
    const stop = statements(ACTIONS_POLICY).filter((statement) => statement.Action.some((action) => !READ_ONLY.test(action)))
    expect(stop.map((statement) => statement.Resource)).toEqual([['arn:aws:ec2:*:*:instance/*', 'arn:aws:rds:*:*:db:*']])
  })

  it('repeats nothing from the read-only policy', () => {
    const readOnly = new Set(actionsOf(READ_ONLY_POLICY))
    expect(actionsOf(ACTIONS_POLICY).filter((action) => readOnly.has(action))).toEqual([])
  })
})
