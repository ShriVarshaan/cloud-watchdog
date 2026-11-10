import { describe, expect, it } from 'vitest'
import { createSanitizer } from '../../scripts/sanitize'

const REAL_ACCOUNT = '482915730264'
const sanitize = (value: unknown) => createSanitizer(REAL_ACCOUNT)(value)

describe('fixture sanitiser', () => {
  it('replaces the real account id everywhere, including inside ARNs', () => {
    expect(
      sanitize({
        OwnerId: '482915730264',
        Arn: 'arn:aws:iam::482915730264:user/alice',
        Note: 'owned by 482915730264.'
      })
    ).toEqual({
      OwnerId: '111122223333',
      Arn: 'arn:aws:iam::111122223333:user/name-1',
      Note: 'owned by 111122223333.'
    })
  })

  it('replaces other 12-digit account ids with a different placeholder', () => {
    const out = sanitize({ RequesterId: '987654321098', ImageOwner: '987654321098', Other: '123123123123' }) as Record<
      string,
      string
    >
    expect(out.RequesterId).toBe('000000000001')
    expect(out.ImageOwner).toBe('000000000001')
    expect(out.Other).toBe('000000000002')
  })

  it('replaces resource ids, keeping the prefix, and maps the same id to the same value', () => {
    const out = sanitize({
      InstanceId: 'i-0f3a9c2b7d1e4a5b6',
      VpcId: 'vpc-0a1b2c3d',
      Attachment: { InstanceId: 'i-0f3a9c2b7d1e4a5b6', VolumeId: 'vol-0123456789abcdef0' }
    })
    expect(out).toEqual({
      InstanceId: 'i-00000000000000001',
      VpcId: 'vpc-00000000000000002',
      Attachment: { InstanceId: 'i-00000000000000001', VolumeId: 'vol-00000000000000003' }
    })
  })

  it('replaces public and private IPv4 addresses with documentation ranges', () => {
    expect(sanitize({ PublicIpAddress: '54.171.20.9', PrivateIpAddress: '172.31.4.17', Again: '54.171.20.9' })).toEqual({
      PublicIpAddress: '203.0.113.1',
      PrivateIpAddress: '10.0.0.1',
      Again: '203.0.113.1'
    })
  })

  it('replaces host names, which embed IP addresses and database names', () => {
    const out = sanitize({
      PublicDnsName: 'ec2-54-171-20-9.eu-west-1.compute.amazonaws.com',
      PrivateDnsName: 'ip-172-31-4-17.eu-west-1.compute.internal',
      Endpoint: { Address: 'shop-db.c9xk2abcdefg.eu-west-1.rds.amazonaws.com', Port: 3306 }
    })
    expect(out).toEqual({
      PublicDnsName: 'host-1.example.invalid',
      PrivateDnsName: 'host-2.example.invalid',
      Endpoint: { Address: 'host-3.example.invalid', Port: 3306 }
    })
  })

  it('leaves empty host names empty', () => {
    expect(sanitize({ PublicDnsName: '' })).toEqual({ PublicDnsName: '' })
  })

  it('replaces tag values and custom tag keys, keeping Name and aws: keys', () => {
    expect(
      sanitize({
        Tags: [
          { Key: 'Name', Value: 'alice-thesis-box' },
          { Key: 'aws:autoscaling:groupName', Value: 'alice-fleet' },
          { Key: 'CostCentre', Value: 'dept-42' },
          { Key: 'Empty', Value: '' }
        ]
      })
    ).toEqual({
      Tags: [
        { Key: 'Name', Value: 'name-1' },
        { Key: 'aws:autoscaling:groupName', Value: 'name-2' },
        { Key: 'tag-key-1', Value: 'name-3' },
        { Key: 'tag-key-2', Value: '' }
      ]
    })
  })

  it('replaces names, and the same name wherever else it appears', () => {
    expect(
      sanitize({
        DBInstanceArn: 'arn:aws:rds:eu-west-1:482915730264:db:shop-db',
        DBInstanceIdentifier: 'shop-db',
        MasterUsername: 'alice',
        DBName: 'shop',
        KeyName: 'alice-laptop',
        ReadReplicaDBInstanceIdentifiers: ['shop-db-replica'],
        ReadReplicaSourceDBInstanceIdentifier: 'shop-db',
        StatusMessage: 'Replica of shop-db is healthy'
      })
    ).toEqual({
      DBInstanceArn: 'arn:aws:rds:eu-west-1:111122223333:db:name-1',
      DBInstanceIdentifier: 'name-1',
      MasterUsername: 'name-2',
      DBName: 'name-3',
      KeyName: 'name-4',
      ReadReplicaDBInstanceIdentifiers: ['name-5'],
      ReadReplicaSourceDBInstanceIdentifier: 'name-1',
      StatusMessage: 'Replica of name-1 is healthy'
    })
  })

  it('does not rewrite a name that is only part of a longer word', () => {
    expect(sanitize({ DBInstanceIdentifier: 'shop', Engine: 'workshop-engine', Note: 'shop is up' })).toEqual({
      DBInstanceIdentifier: 'name-1',
      Engine: 'workshop-engine',
      Note: 'name-1 is up'
    })
  })

  it('does not rewrite other fields that happen to equal a database name, user or tag value', () => {
    const input = {
      Engine: 'postgres',
      DBName: 'postgres',
      MasterUsername: 'postgres',
      State: { Name: 'running' },
      Tags: [{ Key: 'Name', Value: 'running' }]
    }
    expect(sanitize(input)).toMatchObject({ Engine: 'postgres', DBName: 'name-1', State: { Name: 'running' } })
  })

  it('keeps the well-known name "default"', () => {
    expect(sanitize({ GroupName: 'default', DBParameterGroupName: 'default.mysql8.0' })).toEqual({
      GroupName: 'default',
      DBParameterGroupName: 'default.mysql8.0'
    })
  })

  it('replaces the name part of an ARN but keeps a resource id recognisable', () => {
    expect(
      sanitize({
        Role: 'arn:aws:iam::482915730264:instance-profile/alice-admin-role',
        Key: 'arn:aws:kms:eu-west-1:482915730264:key/3f2a9c1b-7d1e-4a5b-8c6d-0123456789ab',
        Instance: 'arn:aws:ec2:eu-west-1:482915730264:instance/i-0f3a9c2b7d1e4a5b6'
      })
    ).toEqual({
      Role: 'arn:aws:iam::111122223333:instance-profile/name-1',
      Key: 'arn:aws:kms:eu-west-1:111122223333:key/name-2',
      Instance: 'arn:aws:ec2:eu-west-1:111122223333:instance/i-00000000000000001'
    })
  })

  it('replaces MAC addresses, IPv6 addresses and e-mail addresses', () => {
    expect(
      sanitize({
        MacAddress: '0a:1b:2c:3d:4e:5f',
        Ipv6Address: '2a05:d018:abc:1200:1234:5678:9abc:def0',
        Contact: 'mail alice@university.example.org today'
      })
    ).toEqual({
      MacAddress: '02:00:00:00:00:01',
      Ipv6Address: '2001:db8::1',
      Contact: 'mail user@example.com today'
    })
  })

  it('leaves what pricing and rules read untouched', () => {
    const useful = {
      InstanceType: 't3.micro',
      State: { Code: 16, Name: 'running' },
      LaunchTime: '2026-11-08T14:30:00.000Z',
      PlatformDetails: 'Linux/UNIX',
      UsageOperation: 'RunInstances:0002',
      Placement: { AvailabilityZone: 'eu-west-1a', Tenancy: 'default' },
      EngineVersion: '15.00.4236.7.v1',
      AllocatedStorage: 20,
      MultiAZ: false,
      StorageType: 'gp3',
      InstanceLifecycle: null
    }
    expect(sanitize(useful)).toEqual(useful)
  })

  it('removes the SDK response metadata', () => {
    expect(sanitize({ $metadata: { requestId: 'abc', attempts: 1 }, Reservations: [] })).toEqual({ Reservations: [] })
  })

  it('uses the same replacements across calls of one sanitiser, so files stay consistent', () => {
    const shared = createSanitizer(REAL_ACCOUNT)
    const first = shared({ InstanceId: 'i-0f3a9c2b7d1e4a5b6' })
    const second = shared({ Attachments: [{ InstanceId: 'i-0f3a9c2b7d1e4a5b6' }] })
    expect(first).toEqual({ InstanceId: 'i-00000000000000001' })
    expect(second).toEqual({ Attachments: [{ InstanceId: 'i-00000000000000001' }] })
  })

  it('does not change the object it was given', () => {
    const input = { InstanceId: 'i-0f3a9c2b7d1e4a5b6', Tags: [{ Key: 'Name', Value: 'secret' }] }
    sanitize(input)
    expect(input).toEqual({ InstanceId: 'i-0f3a9c2b7d1e4a5b6', Tags: [{ Key: 'Name', Value: 'secret' }] })
  })
})
