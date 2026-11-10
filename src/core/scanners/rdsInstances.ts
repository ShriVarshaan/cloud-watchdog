// RDS database instances in one region. Same three steps as ec2Instances.ts.
//
// DescribeDBInstances also lists Aurora cluster members, and Neptune and
// DocumentDB instances (they share the RDS API). They are kept, with their
// `engine`, so nothing that costs money is hidden; pricing (M5) decides what
// it can price.

import { paginateDescribeDBInstances, RDSClient, type DBInstance } from '@aws-sdk/client-rds'
import { resourceKey, type Resource } from '../../shared/types'
import type { ScanContext, Scanner } from '../scan/scanner'

function toResource(db: DBInstance, ctx: ScanContext): Resource | null {
  const id = db.DBInstanceIdentifier
  if (!id) return null

  return {
    key: resourceKey(ctx.accountId, 'rds-instance', ctx.region, id),
    kind: 'rds-instance',
    region: ctx.region,
    id,
    state: db.DBInstanceStatus ?? 'unknown',
    ...(db.InstanceCreateTime ? { createdAt: db.InstanceCreateTime.toISOString() } : {}),
    attrs: {
      instanceClass: db.DBInstanceClass ?? null,
      engine: db.Engine ?? null,
      licenseModel: db.LicenseModel ?? null,
      multiAz: db.MultiAZ ?? null,
      storageType: db.StorageType ?? null,
      allocatedStorageGb: db.AllocatedStorage ?? null,
      iops: db.Iops ?? null,
      // Set for Aurora members: their storage is billed on the cluster.
      clusterId: db.DBClusterIdentifier ?? null,
      // Replica links. A replica, or an instance with replicas, cannot be stopped.
      replicaSourceId: db.ReadReplicaSourceDBInstanceIdentifier ?? null,
      replicaCount: db.ReadReplicaDBInstanceIdentifiers?.length ?? 0,
      publiclyAccessible: db.PubliclyAccessible ?? null
    }
  }
}

export const rdsInstances: Scanner = {
  kind: 'rds-instance',
  service: 'rds',
  requiredActions: ['rds:DescribeDBInstances'],

  async scan(ctx) {
    const client = ctx.clients.get(RDSClient, ctx.region)
    const resources: Resource[] = []
    for await (const page of paginateDescribeDBInstances({ client }, {}, { abortSignal: ctx.signal })) {
      for (const db of page.DBInstances ?? []) {
        const resource = toResource(db, ctx)
        if (resource) resources.push(resource)
      }
    }
    return resources
  }
}
