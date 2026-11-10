import { CloudWatchClient, GetMetricDataCommand, type GetMetricDataCommandInput } from '@aws-sdk/client-cloudwatch'
import { mockClient } from 'aws-sdk-client-mock'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AttrValue, ResourceKind } from '../../shared/types'
import { createClientFactory, type ClientFactory } from '../aws/clients'
import { openDb } from '../store/db'
import { migrate } from '../store/migrations'
import { createRepo, type Repo } from '../store/repo'
import type { RuleResource } from './engine'
import { createIdleDetector } from './idle'

const cloudwatch = mockClient(CloudWatchClient)
afterEach(() => cloudwatch.reset())

const real = createClientFactory({
  profile: 'hackathon',
  credentials: async () => ({ accessKeyId: 'AKIAFAKEFAKEFAKEFAKE', secretAccessKey: 'fake' })
})
let regionsUsed: string[]
const clients: ClientFactory = {
  profile: real.profile,
  get: (service, region) => {
    regionsUsed.push(region)
    return real.get(service, region)
  },
  destroy: () => real.destroy()
}

// 20 minutes past the hour: the window must end at 12:00, not at 12:20.
let now: Date
const WINDOW_END = '2026-11-10T12:00:00.000Z'
const LONG_AGO = '2026-11-01T00:00:00.000Z'
const signal = new AbortController().signal

let repo: Repo
beforeEach(() => {
  const db = openDb(':memory:')
  migrate(db)
  repo = createRepo(db)
  now = new Date('2026-11-10T12:20:00.000Z')
  regionsUsed = []
})

const detector = () => createIdleDetector({ clients, cache: repo, now: () => now })
const inputs = (): GetMetricDataCommandInput[] => cloudwatch.commandCalls(GetMetricDataCommand).map((call) => call.args[0].input)

function make(kind: ResourceKind, id: string, state: string, over: Partial<RuleResource> = {}, attrs: Record<string, AttrValue> = {}): RuleResource {
  const region = over.region ?? 'eu-west-1'
  return { key: `111122223333:${kind}:${region}:${id}`, kind, region, id, state, createdAt: LONG_AGO, attrs, stale: false, ...over }
}
const instance = (id: string, over: Partial<RuleResource> = {}) => make('ec2-instance', id, 'running', over)

describe('the CloudWatch query', () => {
  it('asks for the hourly maximum CPU of an EC2 instance over whole hours ending at the current hour', async () => {
    cloudwatch.on(GetMetricDataCommand).resolves({ MetricDataResults: [{ Id: 'm0', Values: [1.2, 0.4, 1.9, 0.3, 0.2, 0.8] }] })
    const web = instance('i-0aaa')

    const { readings, errors } = await detector().read([web], 6, signal)
    expect(errors).toEqual([])
    expect(readings.get(web.key)).toEqual({ maxCpu: 1.9, datapoints: 6, windowEnd: WINDOW_END })
    expect(regionsUsed).toEqual(['eu-west-1'])
    expect(inputs()).toEqual([
      {
        StartTime: new Date('2026-11-10T06:00:00.000Z'),
        EndTime: new Date(WINDOW_END),
        MetricDataQueries: [
          {
            Id: 'm0',
            ReturnData: true,
            MetricStat: {
              Metric: { Namespace: 'AWS/EC2', MetricName: 'CPUUtilization', Dimensions: [{ Name: 'InstanceId', Value: 'i-0aaa' }] },
              Period: 3600,
              Stat: 'Maximum'
            }
          }
        ]
      }
    ])
  })

  it('asks for a database by its identifier in the RDS namespace', async () => {
    cloudwatch.on(GetMetricDataCommand).resolves({ MetricDataResults: [{ Id: 'm0', Values: [3] }] })
    await detector().read([make('rds-instance', 'shop-db', 'available')], 6, signal)
    expect(inputs()[0]!.MetricDataQueries![0]!.MetricStat!.Metric).toEqual({
      Namespace: 'AWS/RDS',
      MetricName: 'CPUUtilization',
      Dimensions: [{ Name: 'DBInstanceIdentifier', Value: 'shop-db' }]
    })
  })

  it('uses the window length it is given', async () => {
    cloudwatch.on(GetMetricDataCommand).resolves({ MetricDataResults: [] })
    await detector().read([instance('i-0aaa')], 12, signal)
    expect(inputs()[0]!.StartTime).toEqual(new Date('2026-11-10T00:00:00.000Z'))
  })

  it('reports no datapoints for a resource CloudWatch returned nothing for', async () => {
    cloudwatch.on(GetMetricDataCommand).resolves({ MetricDataResults: [{ Id: 'm0', Values: [] }] })
    const a = instance('i-0aaa')
    const b = instance('i-0bbb')
    const { readings } = await detector().read([a, b], 6, signal)
    expect(readings.get(a.key)).toEqual({ maxCpu: null, datapoints: 0, windowEnd: WINDOW_END })
    expect(readings.get(b.key)).toEqual({ maxCpu: null, datapoints: 0, windowEnd: WINDOW_END })
  })

  it('adds up the datapoints of one metric that arrive on different pages', async () => {
    cloudwatch
      .on(GetMetricDataCommand)
      .resolves({ MetricDataResults: [{ Id: 'm0', Values: [1, 2, 3] }], NextToken: 'page-2' })
      .on(GetMetricDataCommand, { NextToken: 'page-2' })
      .resolves({ MetricDataResults: [{ Id: 'm0', Values: [0.5, 7, 1] }] })
    const web = instance('i-0aaa')
    const { readings } = await detector().read([web], 6, signal)
    expect(readings.get(web.key)).toMatchObject({ maxCpu: 7, datapoints: 6 })
  })

  it('sends at most 500 metrics per call', async () => {
    cloudwatch.on(GetMetricDataCommand).resolves({ MetricDataResults: [] })
    const many = Array.from({ length: 501 }, (_, i) => instance(`i-${i}`))
    const { readings } = await detector().read(many, 6, signal)

    expect(inputs().map((input) => input.MetricDataQueries!.length)).toEqual([500, 1])
    expect(readings.size).toBe(501)
  })

  it('makes one call per region, to that region', async () => {
    cloudwatch.on(GetMetricDataCommand).resolves({ MetricDataResults: [] })
    await detector().read([instance('i-1'), instance('i-2', { region: 'us-east-1' }), instance('i-3')], 6, signal)
    expect(regionsUsed.sort()).toEqual(['eu-west-1', 'us-east-1'])
    expect(inputs()).toHaveLength(2)
  })
})

describe('which resources are measured', () => {
  it.each<[string, RuleResource]>([
    ['a stopped instance', make('ec2-instance', 'i-1', 'stopped')],
    ['a stopped database', make('rds-instance', 'db-1', 'stopped')],
    ['a volume', make('ebs-volume', 'vol-1', 'in-use')],
    ['a load balancer', make('load-balancer', 'lb-1', 'active')],
    ['a stale instance', instance('i-1', { stale: true })],
    // Started 5 hours 20 minutes ago: the 6-hour window is not all its own.
    ['an instance younger than the window', instance('i-1', { createdAt: '2026-11-10T07:00:00.000Z' })],
    ['an instance with no start time', { ...instance('i-1'), createdAt: undefined } as unknown as RuleResource]
  ])('skips %s without calling CloudWatch', async (_name, resource) => {
    const { readings, errors } = await detector().read([resource], 6, signal)
    expect(readings.size).toBe(0)
    expect(errors).toEqual([])
    expect(inputs()).toEqual([])
  })

  it('measures an instance started exactly when the window begins', async () => {
    cloudwatch.on(GetMetricDataCommand).resolves({ MetricDataResults: [] })
    await detector().read([instance('i-1', { createdAt: '2026-11-10T06:00:00.000Z' })], 6, signal)
    expect(inputs()).toHaveLength(1)
  })
})

describe('asking at most once an hour', () => {
  it('answers from the cache for the rest of the hour', async () => {
    cloudwatch.on(GetMetricDataCommand).resolves({ MetricDataResults: [{ Id: 'm0', Values: [1, 1, 1, 1, 1, 1] }] })
    const web = instance('i-0aaa')
    const idle = detector()
    const first = await idle.read([web], 6, signal)

    now = new Date('2026-11-10T12:59:00.000Z')
    const second = await idle.read([web], 6, signal)
    expect(second.readings).toEqual(first.readings)
    expect(inputs()).toHaveLength(1)
  })

  it('asks again in the next hour, for the next window', async () => {
    cloudwatch.on(GetMetricDataCommand).resolves({ MetricDataResults: [{ Id: 'm0', Values: [1] }] })
    const web = instance('i-0aaa')
    const idle = detector()
    await idle.read([web], 6, signal)

    now = new Date('2026-11-10T13:00:00.000Z')
    const { readings } = await idle.read([web], 6, signal)
    expect(inputs()).toHaveLength(2)
    expect(readings.get(web.key)!.windowEnd).toBe('2026-11-10T13:00:00.000Z')
  })

  it('asks only for the resources that are not cached yet', async () => {
    cloudwatch.on(GetMetricDataCommand).resolves({ MetricDataResults: [{ Id: 'm0', Values: [1] }] })
    const idle = detector()
    await idle.read([instance('i-0aaa')], 6, signal)
    await idle.read([instance('i-0aaa'), instance('i-0bbb')], 6, signal)

    const second = inputs()[1]!.MetricDataQueries!
    expect(second.map((query) => query.MetricStat!.Metric!.Dimensions![0]!.Value)).toEqual(['i-0bbb'])
  })

  it('survives a restart: the cache is in the store', async () => {
    cloudwatch.on(GetMetricDataCommand).resolves({ MetricDataResults: [{ Id: 'm0', Values: [1.5] }] })
    const web = instance('i-0aaa')
    await detector().read([web], 6, signal)

    const { readings } = await detector().read([web], 6, signal)
    expect(readings.get(web.key)).toEqual({ maxCpu: 1.5, datapoints: 1, windowEnd: WINDOW_END })
    expect(inputs()).toHaveLength(1)
  })
})

describe('when CloudWatch fails', () => {
  const denied = Object.assign(new Error('User is not authorized to perform: cloudwatch:GetMetricData'), { name: 'AccessDenied' })

  it('reports the region as a cloudwatch error and gives no readings for it, while other regions still work', async () => {
    cloudwatch.on(GetMetricDataCommand).callsFake(async (_input, getClient) => {
      if ((await getClient().config.region()) === 'eu-west-1') throw denied
      return { MetricDataResults: [{ Id: 'm0', Values: [0.5] }] }
    })
    const blocked = instance('i-1')
    const fine = instance('i-2', { region: 'us-east-1' })

    const { readings, errors } = await detector().read([blocked, fine], 6, signal)
    expect(errors).toEqual([
      { scanner: 'cloudwatch', region: 'eu-west-1', code: 'access-denied', message: 'User is not authorized to perform: cloudwatch:GetMetricData' }
    ])
    expect(readings.has(blocked.key)).toBe(false)
    expect(readings.get(fine.key)).toMatchObject({ maxCpu: 0.5 })
  })

  it('does not cache a failure: the next read tries again', async () => {
    cloudwatch.on(GetMetricDataCommand).rejectsOnce(denied).resolves({ MetricDataResults: [{ Id: 'm0', Values: [0.5] }] })
    const web = instance('i-1')
    const idle = detector()
    await idle.read([web], 6, signal)
    expect((await idle.read([web], 6, signal)).readings.get(web.key)).toMatchObject({ maxCpu: 0.5 })
  })

  it('rejects, instead of reporting an error, when the scan was cancelled', async () => {
    const controller = new AbortController()
    cloudwatch.on(GetMetricDataCommand).callsFake(() => {
      controller.abort()
      throw Object.assign(new Error('Request aborted'), { name: 'AbortError' })
    })
    await expect(detector().read([instance('i-1')], 6, controller.signal)).rejects.toThrow('Request aborted')
  })
})
