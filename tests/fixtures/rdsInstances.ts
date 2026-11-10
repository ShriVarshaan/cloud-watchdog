// Hand-written DescribeDBInstances data in the shape the SDK returns it, with
// made-up ids. Replace or extend with recorded responses from
// `scripts/record-fixtures.ts` (see tests/fixtures/recorded/).

import type { DBInstance } from '@aws-sdk/client-rds'

/** A single-AZ MySQL instance that is publicly reachable. */
export const mysqlAvailable: DBInstance = {
  DBInstanceIdentifier: 'demo-db',
  DBInstanceArn: 'arn:aws:rds:eu-west-1:111122223333:db:demo-db',
  DbiResourceId: 'db-ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  DBInstanceClass: 'db.t3.micro',
  Engine: 'mysql',
  EngineVersion: '8.0.39',
  DBInstanceStatus: 'available',
  MasterUsername: 'admin',
  DBName: 'app',
  Endpoint: { Address: 'demo-db.abcdefghijkl.eu-west-1.rds.amazonaws.com', Port: 3306, HostedZoneId: 'Z29XKXDKYMONMX' },
  AllocatedStorage: 20,
  InstanceCreateTime: new Date('2026-11-01T12:00:00.000Z'),
  PreferredBackupWindow: '03:00-03:30',
  BackupRetentionPeriod: 7,
  DBSecurityGroups: [],
  VpcSecurityGroups: [{ VpcSecurityGroupId: 'sg-0aaa1111bbbb22223', Status: 'active' }],
  AvailabilityZone: 'eu-west-1a',
  MultiAZ: false,
  AutoMinorVersionUpgrade: true,
  ReadReplicaDBInstanceIdentifiers: [],
  LicenseModel: 'general-public-license',
  PubliclyAccessible: true,
  StorageType: 'gp3',
  Iops: 3000,
  StorageThroughput: 125,
  StorageEncrypted: true,
  KmsKeyId: 'arn:aws:kms:eu-west-1:111122223333:key/11111111-2222-3333-4444-555555555555',
  DeletionProtection: false,
  TagList: [{ Key: 'project', Value: 'hackathon' }]
}

/** A stopped Multi-AZ PostgreSQL primary that has two read replicas. */
export const postgresStoppedWithReplicas: DBInstance = {
  DBInstanceIdentifier: 'orders-primary',
  DBInstanceArn: 'arn:aws:rds:eu-west-1:111122223333:db:orders-primary',
  DBInstanceClass: 'db.m6g.large',
  Engine: 'postgres',
  EngineVersion: '16.4',
  DBInstanceStatus: 'stopped',
  AllocatedStorage: 100,
  InstanceCreateTime: new Date('2026-09-15T09:30:00.000Z'),
  MultiAZ: true,
  ReadReplicaDBInstanceIdentifiers: ['orders-replica-1', 'orders-replica-2'],
  LicenseModel: 'postgresql-license',
  PubliclyAccessible: false,
  StorageType: 'io1',
  Iops: 6000
}

/** A read replica of the instance above. */
export const postgresReplica: DBInstance = {
  DBInstanceIdentifier: 'orders-replica-1',
  DBInstanceClass: 'db.m6g.large',
  Engine: 'postgres',
  DBInstanceStatus: 'available',
  AllocatedStorage: 100,
  InstanceCreateTime: new Date('2026-09-16T10:00:00.000Z'),
  MultiAZ: false,
  ReadReplicaSourceDBInstanceIdentifier: 'orders-primary',
  ReadReplicaDBInstanceIdentifiers: [],
  LicenseModel: 'postgresql-license',
  PubliclyAccessible: false,
  StorageType: 'io1'
}

/** A member of an Aurora cluster: storage belongs to the cluster, so AllocatedStorage is 1. */
export const auroraMember: DBInstance = {
  DBInstanceIdentifier: 'aurora-writer',
  DBInstanceClass: 'db.r6g.large',
  Engine: 'aurora-mysql',
  DBInstanceStatus: 'available',
  AllocatedStorage: 1,
  InstanceCreateTime: new Date('2026-11-05T18:45:00.000Z'),
  DBClusterIdentifier: 'aurora-demo',
  MultiAZ: false,
  ReadReplicaDBInstanceIdentifiers: [],
  LicenseModel: 'general-public-license',
  PubliclyAccessible: false,
  StorageType: 'aurora'
}
