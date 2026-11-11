// Stopping one RDS database instance: how to look at it, what forbids
// stopping it, what stopping it means, and the stop call itself. The
// decisions about tokens, confirmation and re-checking are in guard.ts.
//
// The stop is a plain StopDBInstance for one identifier, with no snapshot.
// RDS has no dry run, so a missing permission shows up as a refused stop.

import { DescribeDBInstancesCommand, RDSClient, StopDBInstanceCommand, type DBInstance } from '@aws-sdk/client-rds'
import { hasErrorName } from '../aws/errors'
import type { ActionDriver, Facts } from './guard'

export const stopRds: ActionDriver = {
  action: 'stop-rds',
  kind: 'rds-instance',
  done: 'AWS is stopping the database. It takes a few minutes; a later scan shows it as stopped. AWS starts it again by itself after 7 days.',

  async observe(clients, region, id): Promise<Facts | null> {
    let db: DBInstance | undefined
    try {
      const response = await clients.get(RDSClient, region).send(new DescribeDBInstancesCommand({ DBInstanceIdentifier: id }))
      db = (response.DBInstances ?? []).find((found) => found.DBInstanceIdentifier === id)
    } catch (error) {
      if (hasErrorName(error, 'DBInstanceNotFoundFault') || hasErrorName(error, 'DBInstanceNotFound')) return null
      throw error
    }
    if (!db) return null

    return {
      state: db.DBInstanceStatus ?? 'unknown',
      engine: db.Engine ?? null,
      multiAz: db.MultiAZ ?? null,
      // Set for Aurora members and for members of a Multi-AZ DB cluster.
      clusterId: db.DBClusterIdentifier ?? null,
      replicaSource: db.ReadReplicaSourceDBInstanceIdentifier ?? db.ReadReplicaSourceDBClusterIdentifier ?? null,
      replicaCount: (db.ReadReplicaDBInstanceIdentifiers?.length ?? 0) + (db.ReadReplicaDBClusterIdentifiers?.length ?? 0)
    }
  },

  blockers(facts) {
    if (facts.state !== 'available') return [`It is ${facts.state}, not available.`]

    const found: string[] = []
    if (facts.clusterId) {
      found.push(`It is part of the database cluster "${facts.clusterId}". A cluster is stopped as a whole, which Cloud Watchdog does not do.`)
    }
    if (facts.replicaSource) found.push('It is a read replica. AWS does not allow stopping one.')
    if (typeof facts.replicaCount === 'number' && facts.replicaCount > 0) {
      found.push('It has read replicas. AWS does not allow stopping it.')
    }
    // Anything but a clear "single zone" counts as Multi-AZ here.
    if (typeof facts.engine === 'string' && facts.engine.startsWith('sqlserver') && facts.multiAz !== false) {
      found.push('It is a SQL Server database in a Multi-AZ deployment. AWS does not allow stopping one.')
    }
    return found
  },

  consequences() {
    return [
      'AWS starts it again by itself after 7 days. Cloud Watchdog warns you when that happens.',
      'Its storage and backups keep billing while it is stopped.',
      'Nothing can connect to it until it is started again.',
      'Cloud Watchdog cannot start it again. You start it from the AWS console or with the AWS CLI.'
    ]
  },

  async stop(clients, region, id) {
    await clients.get(RDSClient, region).send(new StopDBInstanceCommand({ DBInstanceIdentifier: id }))
  }
}
