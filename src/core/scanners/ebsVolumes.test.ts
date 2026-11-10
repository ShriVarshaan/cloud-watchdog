import { DescribeVolumesCommand, EC2Client } from '@aws-sdk/client-ec2'
import { mockClient } from 'aws-sdk-client-mock'
import { afterEach, describe, expect, it } from 'vitest'
import { deleted, gp3Attached, io2Unattached, magnetic, multiAttached } from '../../../tests/fixtures/ebsVolumes'
import { createClientFactory } from '../aws/clients'
import { classifyAwsError } from '../aws/errors'
import type { ScanContext } from '../scan/scanner'
import { ebsVolumes } from './ebsVolumes'

const ec2 = mockClient(EC2Client)
afterEach(() => ec2.reset())

const clients = createClientFactory({
  profile: 'hackathon',
  credentials: async () => ({ accessKeyId: 'AKIAFAKEFAKEFAKEFAKE', secretAccessKey: 'fake' })
})

function ctx(region = 'eu-west-1', signal: AbortSignal = new AbortController().signal): ScanContext {
  return { accountId: '111122223333', region, clients, signal }
}

describe('ebsVolumes scanner', () => {
  it('maps an attached gp3 volume to a resource', async () => {
    ec2.on(DescribeVolumesCommand).resolves({ Volumes: [gp3Attached] })

    expect(await ebsVolumes.scan(ctx())).toEqual([
      {
        key: '111122223333:ebs-volume:eu-west-1:vol-0aaa1111bbbb22223',
        kind: 'ebs-volume',
        region: 'eu-west-1',
        id: 'vol-0aaa1111bbbb22223',
        name: 'demo-web-root',
        state: 'in-use',
        createdAt: '2026-11-08T14:30:01.000Z',
        attrs: {
          volumeType: 'gp3',
          sizeGb: 8,
          iops: 3000,
          throughputMibps: 125,
          attachedInstanceId: 'i-0aaa1111bbbb22223',
          attachmentCount: 1
        }
      }
    ])
  })

  it('maps an unattached provisioned-IOPS volume', async () => {
    ec2.on(DescribeVolumesCommand).resolves({ Volumes: [io2Unattached] })
    const [found] = await ebsVolumes.scan(ctx())

    expect(found).not.toHaveProperty('name')
    expect(found).toMatchObject({
      state: 'available',
      attrs: {
        volumeType: 'io2',
        sizeGb: 500,
        iops: 16000,
        throughputMibps: null,
        attachedInstanceId: null,
        attachmentCount: 0
      }
    })
  })

  it('counts every Multi-Attach attachment and ignores an empty Name tag', async () => {
    ec2.on(DescribeVolumesCommand).resolves({ Volumes: [multiAttached] })
    const [found] = await ebsVolumes.scan(ctx('us-east-1'))

    expect(found).not.toHaveProperty('name')
    expect(found?.attrs).toMatchObject({ attachedInstanceId: 'i-0eee5555ffff66667', attachmentCount: 2 })
  })

  it('records null for figures AWS leaves out', async () => {
    ec2.on(DescribeVolumesCommand).resolves({ Volumes: [magnetic, { VolumeId: 'vol-0abcdef0123456789' }] })
    const [standard, bare] = await ebsVolumes.scan(ctx())

    expect(standard?.attrs).toMatchObject({ volumeType: 'standard', sizeGb: 30, iops: null, throughputMibps: null })
    expect(bare).toMatchObject({
      state: 'unknown',
      attrs: {
        volumeType: null,
        sizeGb: null,
        iops: null,
        throughputMibps: null,
        attachedInstanceId: null,
        attachmentCount: 0
      }
    })
    expect(bare).not.toHaveProperty('createdAt')
  })

  it('leaves out deleted volumes', async () => {
    ec2.on(DescribeVolumesCommand).resolves({ Volumes: [deleted, gp3Attached] })
    expect((await ebsVolumes.scan(ctx())).map((r) => r.id)).toEqual(['vol-0aaa1111bbbb22223'])
  })

  it('skips an entry that has no volume id', async () => {
    ec2.on(DescribeVolumesCommand).resolves({ Volumes: [{ State: 'available', Size: 8 }] })
    expect(await ebsVolumes.scan(ctx())).toEqual([])
  })

  it('reads every page', async () => {
    ec2
      .on(DescribeVolumesCommand)
      .resolves({ Volumes: [gp3Attached, io2Unattached], NextToken: 'page-2' })
      .on(DescribeVolumesCommand, { NextToken: 'page-2' })
      .resolves({ Volumes: [multiAttached] })

    const found = await ebsVolumes.scan(ctx())

    expect(found.map((r) => r.id)).toEqual(['vol-0aaa1111bbbb22223', 'vol-0ccc3333dddd44445', 'vol-0eee5555ffff66667'])
    expect(ec2.commandCalls(DescribeVolumesCommand)).toHaveLength(2)
  })

  it('returns nothing for a region with no volumes', async () => {
    ec2.on(DescribeVolumesCommand).resolves({ Volumes: [] })
    expect(await ebsVolumes.scan(ctx())).toEqual([])
  })

  it('calls the region it was asked to scan, and passes the abort signal on', async () => {
    ec2.on(DescribeVolumesCommand).resolves({ Volumes: [] })
    const signal = new AbortController().signal
    await ebsVolumes.scan(ctx('ap-south-1', signal))

    const [call] = ec2.commandCalls(DescribeVolumesCommand)
    expect(call?.thisValue).toBe(clients.get(EC2Client, 'ap-south-1'))
    expect((call?.args as unknown[])[1]).toMatchObject({ abortSignal: signal })
  })

  it('does not catch errors: the engine classifies them', async () => {
    ec2.on(DescribeVolumesCommand).rejects(Object.assign(new Error('nope'), { name: 'UnauthorizedOperation' }))
    const error = await ebsVolumes.scan(ctx()).catch((e: unknown) => e)
    expect(classifyAwsError(error).code).toBe('access-denied')
  })

  it('declares its limiter bucket, kind and IAM action', () => {
    expect(ebsVolumes).toMatchObject({
      kind: 'ebs-volume',
      service: 'ec2',
      requiredActions: ['ec2:DescribeVolumes']
    })
  })
})
