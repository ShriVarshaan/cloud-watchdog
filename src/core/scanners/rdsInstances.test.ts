import { DescribeDBInstancesCommand, RDSClient } from '@aws-sdk/client-rds'
import { mockClient } from 'aws-sdk-client-mock'
import { afterEach, describe, expect, it } from 'vitest'
import {
  auroraMember,
  mysqlAvailable,
  postgresReplica,
  postgresStoppedWithReplicas
} from '../../../tests/fixtures/rdsInstances'
import { createClientFactory } from '../aws/clients'
import { classifyAwsError } from '../aws/errors'
import type { ScanContext } from '../scan/scanner'
import { rdsInstances } from './rdsInstances'

const rds = mockClient(RDSClient)
afterEach(() => rds.reset())

const clients = createClientFactory({
  profile: 'hackathon',
  credentials: async () => ({ accessKeyId: 'AKIAFAKEFAKEFAKEFAKE', secretAccessKey: 'fake' })
})

function ctx(region = 'eu-west-1', signal: AbortSignal = new AbortController().signal): ScanContext {
  return { accountId: '111122223333', region, clients, signal }
}

describe('rdsInstances scanner', () => {
  it('maps an available instance to a resource', async () => {
    rds.on(DescribeDBInstancesCommand).resolves({ DBInstances: [mysqlAvailable] })

    expect(await rdsInstances.scan(ctx())).toEqual([
      {
        key: '111122223333:rds-instance:eu-west-1:demo-db',
        kind: 'rds-instance',
        region: 'eu-west-1',
        id: 'demo-db',
        state: 'available',
        createdAt: '2026-11-01T12:00:00.000Z',
        attrs: {
          instanceClass: 'db.t3.micro',
          engine: 'mysql',
          licenseModel: 'general-public-license',
          multiAz: false,
          storageType: 'gp3',
          allocatedStorageGb: 20,
          iops: 3000,
          clusterId: null,
          replicaSourceId: null,
          replicaCount: 0,
          publiclyAccessible: true
        }
      }
    ])
  })

  it('records Multi-AZ, provisioned IOPS and how many replicas a stopped primary has', async () => {
    rds.on(DescribeDBInstancesCommand).resolves({ DBInstances: [postgresStoppedWithReplicas] })
    const [found] = await rdsInstances.scan(ctx())
    expect(found).toMatchObject({
      id: 'orders-primary',
      state: 'stopped',
      attrs: {
        instanceClass: 'db.m6g.large',
        engine: 'postgres',
        multiAz: true,
        storageType: 'io1',
        allocatedStorageGb: 100,
        iops: 6000,
        replicaSourceId: null,
        replicaCount: 2,
        publiclyAccessible: false
      }
    })
  })

  it('records which instance a read replica copies', async () => {
    rds.on(DescribeDBInstancesCommand).resolves({ DBInstances: [postgresReplica] })
    const [found] = await rdsInstances.scan(ctx())
    expect(found?.attrs).toMatchObject({ replicaSourceId: 'orders-primary', replicaCount: 0, iops: null })
  })

  it('records the cluster of an Aurora member', async () => {
    rds.on(DescribeDBInstancesCommand).resolves({ DBInstances: [auroraMember] })
    const [found] = await rdsInstances.scan(ctx())
    expect(found?.attrs).toMatchObject({ engine: 'aurora-mysql', clusterId: 'aurora-demo', storageType: 'aurora' })
  })

  it('reads every page', async () => {
    rds
      .on(DescribeDBInstancesCommand)
      .resolves({ DBInstances: [mysqlAvailable, postgresStoppedWithReplicas], Marker: 'page-2' })
      .on(DescribeDBInstancesCommand, { Marker: 'page-2' })
      .resolves({ DBInstances: [auroraMember] })

    const found = await rdsInstances.scan(ctx())

    expect(found.map((r) => r.id)).toEqual(['demo-db', 'orders-primary', 'aurora-writer'])
    expect(rds.commandCalls(DescribeDBInstancesCommand)).toHaveLength(2)
  })

  it('returns nothing for a region with no databases', async () => {
    rds.on(DescribeDBInstancesCommand).resolves({ DBInstances: [] })
    expect(await rdsInstances.scan(ctx())).toEqual([])
  })

  it('skips an entry that has no identifier', async () => {
    rds.on(DescribeDBInstancesCommand).resolves({ DBInstances: [{ DBInstanceStatus: 'available' }] })
    expect(await rdsInstances.scan(ctx())).toEqual([])
  })

  it('calls the region it was asked to scan, and passes the abort signal on', async () => {
    rds.on(DescribeDBInstancesCommand).resolves({ DBInstances: [] })
    const signal = new AbortController().signal
    await rdsInstances.scan(ctx('ap-south-1', signal))

    const [call] = rds.commandCalls(DescribeDBInstancesCommand)
    expect(call?.thisValue).toBe(clients.get(RDSClient, 'ap-south-1'))
    expect((call?.args as unknown[])[1]).toMatchObject({ abortSignal: signal })
  })

  it('does not catch errors: the engine classifies them', async () => {
    rds.on(DescribeDBInstancesCommand).rejects(Object.assign(new Error('nope'), { name: 'AccessDenied' }))
    const error = await rdsInstances.scan(ctx()).catch((e: unknown) => e)
    expect(classifyAwsError(error).code).toBe('access-denied')
  })

  it('declares its limiter bucket and kind', () => {
    expect(rdsInstances).toMatchObject({ kind: 'rds-instance', service: 'rds' })
  })
})
