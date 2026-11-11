import { DescribeDBInstancesCommand, RDSClient, StopDBInstanceCommand, type DBInstance } from '@aws-sdk/client-rds'
import { mockClient } from 'aws-sdk-client-mock'
import { afterEach, describe, expect, it } from 'vitest'
import { createClientFactory } from '../aws/clients'
import { stopRds } from './stopRds'

const rds = mockClient(RDSClient)
afterEach(() => rds.reset())

const clients = createClientFactory({ profile: 'hackathon', credentials: async () => ({ accessKeyId: 'AKIAFAKEFAKEFAKEFAKE', secretAccessKey: 'fake' }) })
const awsError = (name: string, message = name) => Object.assign(new Error(message), { name })

const ordinary: DBInstance = { DBInstanceIdentifier: 'db-1', DBInstanceStatus: 'available', Engine: 'postgres', MultiAZ: false }

const observe = () => stopRds.observe(clients, 'eu-west-1', 'db-1')
async function blockers(db: DBInstance): Promise<string[]> {
  rds.on(DescribeDBInstancesCommand).resolves({ DBInstances: [db] })
  return stopRds.blockers((await observe())!)
}

describe('looking at the database', () => {
  it('asks AWS about that one database, in its region', async () => {
    rds.on(DescribeDBInstancesCommand).resolves({ DBInstances: [ordinary] })
    expect(await observe()).toEqual({
      state: 'available',
      engine: 'postgres',
      multiAz: false,
      clusterId: null,
      replicaSource: null,
      replicaCount: 0
    })
    expect(rds.commandCalls(DescribeDBInstancesCommand).map((call) => call.args[0].input)).toEqual([{ DBInstanceIdentifier: 'db-1' }])
    expect(await clients.get(RDSClient, 'eu-west-1').config.region()).toBe('eu-west-1')
  })

  it('reports a database AWS does not know as gone', async () => {
    rds.on(DescribeDBInstancesCommand).rejects(awsError('DBInstanceNotFoundFault'))
    expect(await observe()).toBeNull()
  })

  it('ignores any other database in the answer', async () => {
    rds.on(DescribeDBInstancesCommand).resolves({ DBInstances: [{ ...ordinary, DBInstanceIdentifier: 'db-10' }] })
    expect(await observe()).toBeNull()
  })

  it('lets any other failure escape', async () => {
    rds.on(DescribeDBInstancesCommand).rejects(awsError('AccessDenied'))
    await expect(observe()).rejects.toThrow('AccessDenied')
  })
})

describe('what blocks stopping a database', () => {
  it('nothing, for an ordinary available database', async () => {
    expect(await blockers(ordinary)).toEqual([])
  })

  it('nothing, for a Multi-AZ database that is not SQL Server', async () => {
    expect(await blockers({ ...ordinary, MultiAZ: true })).toEqual([])
  })

  it.each(['creating', 'stopping', 'stopped', 'modifying', 'backing-up', 'deleting'])('a state of %s', async (state) => {
    expect(await blockers({ ...ordinary, DBInstanceStatus: state })).toEqual([`It is ${state}, not available.`])
  })

  it('being a member of a cluster (Aurora)', async () => {
    const found = await blockers({ ...ordinary, Engine: 'aurora-postgresql', DBClusterIdentifier: 'shop-cluster' })
    expect(found).toHaveLength(1)
    expect(found[0]).toContain('cluster "shop-cluster"')
  })

  it('being a read replica of an instance', async () => {
    expect(await blockers({ ...ordinary, ReadReplicaSourceDBInstanceIdentifier: 'db-0' })).toEqual([
      'It is a read replica. AWS does not allow stopping one.'
    ])
  })

  it('being a read replica of a cluster', async () => {
    expect(await blockers({ ...ordinary, ReadReplicaSourceDBClusterIdentifier: 'shop-cluster' })).toHaveLength(1)
  })

  it('having read replicas', async () => {
    expect(await blockers({ ...ordinary, ReadReplicaDBInstanceIdentifiers: ['db-2'] })).toEqual([
      'It has read replicas. AWS does not allow stopping it.'
    ])
  })

  it('having cluster read replicas', async () => {
    expect(await blockers({ ...ordinary, ReadReplicaDBClusterIdentifiers: ['arn:aws:rds:eu-west-1:111122223333:cluster:copy'] })).toHaveLength(1)
  })

  it('SQL Server in a Multi-AZ deployment', async () => {
    const found = await blockers({ ...ordinary, Engine: 'sqlserver-se', MultiAZ: true })
    expect(found).toHaveLength(1)
    expect(found[0]).toContain('SQL Server')
  })

  it('not SQL Server in a single zone', async () => {
    expect(await blockers({ ...ordinary, Engine: 'sqlserver-ex', MultiAZ: false })).toEqual([])
  })
})

describe('what stopping a database means', () => {
  it('says that AWS starts it again after 7 days, and that storage and backups keep billing', async () => {
    rds.on(DescribeDBInstancesCommand).resolves({ DBInstances: [ordinary] })
    const text = stopRds.consequences((await observe())!).join('\n')
    expect(text).toContain('after 7 days')
    expect(text).toMatch(/storage and backups keep billing/i)
    expect(text).toContain('cannot start it again')
  })
})

describe('stopping', () => {
  it('sends exactly one plain stop, with no snapshot', async () => {
    rds.on(StopDBInstanceCommand).resolves({})
    await stopRds.stop(clients, 'eu-west-1', 'db-1')
    expect(rds.commandCalls(StopDBInstanceCommand).map((call) => call.args[0].input)).toEqual([{ DBInstanceIdentifier: 'db-1' }])
    expect(rds.calls()).toHaveLength(1)
  })

  it('lets a refusal escape', async () => {
    rds.on(StopDBInstanceCommand).rejects(awsError('AccessDenied'))
    await expect(stopRds.stop(clients, 'eu-west-1', 'db-1')).rejects.toThrow('AccessDenied')
  })

  it('has no separate permission check: RDS has no dry run', () => {
    expect(stopRds.checkPermission).toBeUndefined()
  })
})
