import {
  DescribeLoadBalancersCommand as DescribeClassicCommand,
  ElasticLoadBalancingClient
} from '@aws-sdk/client-elastic-load-balancing'
import {
  DescribeLoadBalancersCommand as DescribeV2Command,
  ElasticLoadBalancingV2Client
} from '@aws-sdk/client-elastic-load-balancing-v2'
import { mockClient } from 'aws-sdk-client-mock'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { albActive, classic, gwlbActive, nlbProvisioning } from '../../../tests/fixtures/loadBalancers'
import { createClientFactory } from '../aws/clients'
import { classifyAwsError } from '../aws/errors'
import type { ScanContext } from '../scan/scanner'
import { loadBalancers } from './loadBalancers'

const v2 = mockClient(ElasticLoadBalancingV2Client)
const elb = mockClient(ElasticLoadBalancingClient)

// Each API returns nothing unless a test says otherwise.
beforeEach(() => {
  v2.on(DescribeV2Command).resolves({ LoadBalancers: [] })
  elb.on(DescribeClassicCommand).resolves({ LoadBalancerDescriptions: [] })
})
afterEach(() => {
  v2.reset()
  elb.reset()
})

const clients = createClientFactory({
  profile: 'hackathon',
  credentials: async () => ({ accessKeyId: 'AKIAFAKEFAKEFAKEFAKE', secretAccessKey: 'fake' })
})

function ctx(region = 'eu-west-1', signal: AbortSignal = new AbortController().signal): ScanContext {
  return { accountId: '111122223333', region, clients, signal }
}

describe('loadBalancers scanner', () => {
  it('maps an Application Load Balancer to a resource, using the ARN suffix as the id', async () => {
    v2.on(DescribeV2Command).resolves({ LoadBalancers: [albActive] })

    expect(await loadBalancers.scan(ctx())).toEqual([
      {
        key: '111122223333:load-balancer:eu-west-1:app/demo-alb/50dc6c495c0c9188',
        kind: 'load-balancer',
        region: 'eu-west-1',
        id: 'app/demo-alb/50dc6c495c0c9188',
        name: 'demo-alb',
        state: 'active',
        createdAt: '2026-11-06T10:00:00.000Z',
        attrs: {
          type: 'application',
          scheme: 'internet-facing',
          ipAddressType: 'ipv4',
          zoneCount: 2
        }
      }
    ])
  })

  it('maps network and gateway load balancers', async () => {
    v2.on(DescribeV2Command).resolves({ LoadBalancers: [nlbProvisioning, gwlbActive] })
    const [nlb, gwlb] = await loadBalancers.scan(ctx())

    expect(nlb).toMatchObject({
      id: 'net/api-nlb/73e2d6bc24d8a067',
      state: 'provisioning',
      attrs: { type: 'network', scheme: 'internal', ipAddressType: 'dualstack', zoneCount: 3 }
    })
    expect(gwlb).toMatchObject({
      id: 'gwy/inspect-gwlb/1a2b3c4d5e6f7a8b',
      state: 'active',
      attrs: { type: 'gateway', scheme: null, zoneCount: 1 }
    })
  })

  it('maps a classic load balancer by name, as active', async () => {
    elb.on(DescribeClassicCommand).resolves({ LoadBalancerDescriptions: [classic] })

    expect(await loadBalancers.scan(ctx())).toEqual([
      {
        key: '111122223333:load-balancer:eu-west-1:legacy-web',
        kind: 'load-balancer',
        region: 'eu-west-1',
        id: 'legacy-web',
        name: 'legacy-web',
        // Classic load balancers have no state: one that is listed exists and bills.
        state: 'active',
        createdAt: '2025-06-01T12:00:00.000Z',
        attrs: {
          type: 'classic',
          scheme: 'internet-facing',
          ipAddressType: 'ipv4',
          zoneCount: 2
        }
      }
    ])
  })

  it('lists ELBv2 load balancers first, then classic ones', async () => {
    v2.on(DescribeV2Command).resolves({ LoadBalancers: [albActive] })
    elb.on(DescribeClassicCommand).resolves({ LoadBalancerDescriptions: [classic] })

    expect((await loadBalancers.scan(ctx())).map((r) => r.id)).toEqual(['app/demo-alb/50dc6c495c0c9188', 'legacy-web'])
  })

  it('falls back to the whole ARN when it has no loadbalancer/ part, and records nulls', async () => {
    v2.on(DescribeV2Command).resolves({ LoadBalancers: [{ LoadBalancerArn: 'arn:odd' }] })
    const [found] = await loadBalancers.scan(ctx())

    expect(found).not.toHaveProperty('name')
    expect(found).not.toHaveProperty('createdAt')
    expect(found).toMatchObject({
      id: 'arn:odd',
      state: 'unknown',
      attrs: { type: null, scheme: null, ipAddressType: null, zoneCount: 0 }
    })
  })

  it('skips entries with no ARN (ELBv2) or no name (classic)', async () => {
    v2.on(DescribeV2Command).resolves({ LoadBalancers: [{ LoadBalancerName: 'no-arn' }] })
    elb.on(DescribeClassicCommand).resolves({ LoadBalancerDescriptions: [{ Scheme: 'internal' }] })
    expect(await loadBalancers.scan(ctx())).toEqual([])
  })

  it('reads every page of both APIs', async () => {
    v2.on(DescribeV2Command)
      .resolves({ LoadBalancers: [albActive], NextMarker: 'v2-page-2' })
      .on(DescribeV2Command, { Marker: 'v2-page-2' })
      .resolves({ LoadBalancers: [nlbProvisioning] })
    elb
      .on(DescribeClassicCommand)
      .resolves({ LoadBalancerDescriptions: [classic], NextMarker: 'classic-page-2' })
      .on(DescribeClassicCommand, { Marker: 'classic-page-2' })
      .resolves({ LoadBalancerDescriptions: [{ ...classic, LoadBalancerName: 'legacy-api' }] })

    const found = await loadBalancers.scan(ctx())

    expect(found.map((r) => r.id)).toEqual([
      'app/demo-alb/50dc6c495c0c9188',
      'net/api-nlb/73e2d6bc24d8a067',
      'legacy-web',
      'legacy-api'
    ])
    expect(v2.commandCalls(DescribeV2Command)).toHaveLength(2)
    expect(elb.commandCalls(DescribeClassicCommand)).toHaveLength(2)
  })

  it('returns nothing for a region with no load balancers', async () => {
    expect(await loadBalancers.scan(ctx())).toEqual([])
  })

  it('calls the region it was asked to scan, and passes the abort signal on', async () => {
    const signal = new AbortController().signal
    await loadBalancers.scan(ctx('ap-south-1', signal))

    const [v2Call] = v2.commandCalls(DescribeV2Command)
    expect(v2Call?.thisValue).toBe(clients.get(ElasticLoadBalancingV2Client, 'ap-south-1'))
    expect((v2Call?.args as unknown[])[1]).toMatchObject({ abortSignal: signal })

    const [classicCall] = elb.commandCalls(DescribeClassicCommand)
    expect(classicCall?.thisValue).toBe(clients.get(ElasticLoadBalancingClient, 'ap-south-1'))
    expect((classicCall?.args as unknown[])[1]).toMatchObject({ abortSignal: signal })
  })

  it('does not catch errors from either API: the engine classifies them', async () => {
    const denied = Object.assign(new Error('nope'), { name: 'AccessDenied' })

    v2.on(DescribeV2Command).rejects(denied)
    expect(classifyAwsError(await loadBalancers.scan(ctx()).catch((e: unknown) => e)).code).toBe('access-denied')

    v2.on(DescribeV2Command).resolves({ LoadBalancers: [albActive] })
    elb.on(DescribeClassicCommand).rejects(denied)
    expect(classifyAwsError(await loadBalancers.scan(ctx()).catch((e: unknown) => e)).code).toBe('access-denied')
  })

  it('declares its limiter bucket, kind and IAM action (one action covers both APIs)', () => {
    expect(loadBalancers).toMatchObject({
      kind: 'load-balancer',
      service: 'elb',
      requiredActions: ['elasticloadbalancing:DescribeLoadBalancers']
    })
  })
})
