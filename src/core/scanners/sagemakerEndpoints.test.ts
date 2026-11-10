import {
  DescribeEndpointCommand,
  DescribeEndpointConfigCommand,
  ListEndpointsCommand,
  SageMakerClient
} from '@aws-sdk/client-sagemaker'
import { mockClient } from 'aws-sdk-client-mock'
import { afterEach, describe, expect, it } from 'vitest'
import {
  abTestConfig,
  abTestEndpoint,
  abTestSummary,
  gpuConfig,
  gpuEndpoint,
  gpuSummary,
  serverlessConfig,
  serverlessEndpoint,
  serverlessSummary
} from '../../../tests/fixtures/sagemakerEndpoints'
import { createClientFactory } from '../aws/clients'
import { classifyAwsError } from '../aws/errors'
import type { ScanContext } from '../scan/scanner'
import { sagemakerEndpoints, type SageMakerVariant } from './sagemakerEndpoints'

const sm = mockClient(SageMakerClient)
afterEach(() => sm.reset())

const clients = createClientFactory({
  profile: 'hackathon',
  credentials: async () => ({ accessKeyId: 'AKIAFAKEFAKEFAKEFAKE', secretAccessKey: 'fake' })
})

function ctx(region = 'eu-west-1', signal: AbortSignal = new AbortController().signal): ScanContext {
  return { accountId: '111122223333', region, clients, signal }
}

/** Serves the three fixture endpoints through all three calls. */
function serveFixtures(): void {
  sm.on(ListEndpointsCommand).resolves({ Endpoints: [gpuSummary, serverlessSummary, abTestSummary] })
  sm.on(DescribeEndpointCommand, { EndpointName: 'llm-demo' }).resolves(gpuEndpoint)
  sm.on(DescribeEndpointCommand, { EndpointName: 'classifier' }).resolves(serverlessEndpoint)
  sm.on(DescribeEndpointCommand, { EndpointName: 'ranker' }).resolves(abTestEndpoint)
  sm.on(DescribeEndpointConfigCommand, { EndpointConfigName: 'llm-demo-config' }).resolves(gpuConfig)
  sm.on(DescribeEndpointConfigCommand, { EndpointConfigName: 'classifier-config' }).resolves(serverlessConfig)
  sm.on(DescribeEndpointConfigCommand, { EndpointConfigName: 'ranker-config' }).resolves(abTestConfig)
}

function variantsOf(attrs: Record<string, unknown> | undefined): SageMakerVariant[] {
  return JSON.parse(String(attrs?.variants)) as SageMakerVariant[]
}

const notFound = (what: string) =>
  Object.assign(new Error(`Could not find ${what} "arn:aws:sagemaker:eu-west-1:111122223333:x".`), {
    name: 'ValidationException'
  })

describe('sagemakerEndpoints scanner', () => {
  it('maps an instance endpoint, taking the type from the config and the count from the endpoint', async () => {
    serveFixtures()
    const [gpu] = await sagemakerEndpoints.scan(ctx())

    expect(gpu).toEqual({
      key: '111122223333:sagemaker-endpoint:eu-west-1:llm-demo',
      kind: 'sagemaker-endpoint',
      region: 'eu-west-1',
      id: 'llm-demo',
      name: 'llm-demo',
      state: 'in-service',
      createdAt: '2026-11-09T18:00:00.000Z',
      attrs: {
        // Autoscaled to 2, although the config started it at 1.
        variants: JSON.stringify([{ name: 'AllTraffic', instanceType: 'ml.g5.xlarge', instanceCount: 2, serverless: false, shadow: false }]),
        instanceCount: 2,
        serverless: false
      }
    })
  })

  it('marks a serverless endpoint, which has no instances', async () => {
    serveFixtures()
    const [, classifier] = await sagemakerEndpoints.scan(ctx())

    expect(classifier).toMatchObject({ id: 'classifier', attrs: { instanceCount: 0, serverless: true } })
    expect(variantsOf(classifier?.attrs)).toEqual([
      { name: 'AllTraffic', instanceType: null, instanceCount: 0, serverless: true, shadow: false }
    ])
  })

  it('lists every variant, including shadow variants, and falls back to the desired count', async () => {
    serveFixtures()
    const [, , ranker] = await sagemakerEndpoints.scan(ctx())

    expect(ranker).toMatchObject({ id: 'ranker', state: 'updating', attrs: { instanceCount: 3, serverless: false } })
    expect(variantsOf(ranker?.attrs)).toEqual([
      { name: 'champion', instanceType: 'ml.m5.large', instanceCount: 1, serverless: false, shadow: false },
      { name: 'challenger', instanceType: 'ml.c5.xlarge', instanceCount: 1, serverless: false, shadow: false },
      { name: 'shadow', instanceType: 'ml.m5.large', instanceCount: 1, serverless: false, shadow: true }
    ])
  })

  it('falls back to the initial count in the config when the endpoint reports none', async () => {
    sm.on(ListEndpointsCommand).resolves({ Endpoints: [gpuSummary] })
    sm.on(DescribeEndpointCommand).resolves({
      ...gpuEndpoint,
      ProductionVariants: [{ VariantName: 'AllTraffic' }]
    })
    sm.on(DescribeEndpointConfigCommand).resolves({
      ...gpuConfig,
      ProductionVariants: [{ VariantName: 'AllTraffic', InitialInstanceCount: 3, InstanceType: 'ml.g5.xlarge' }]
    })

    const [found] = await sagemakerEndpoints.scan(ctx())
    expect(found?.attrs.instanceCount).toBe(3)
  })

  it('describes a configuration shared by two endpoints only once', async () => {
    sm.on(ListEndpointsCommand).resolves({
      Endpoints: [gpuSummary, { ...gpuSummary, EndpointName: 'llm-demo-2' }]
    })
    sm.on(DescribeEndpointCommand, { EndpointName: 'llm-demo' }).resolves(gpuEndpoint)
    sm.on(DescribeEndpointCommand, { EndpointName: 'llm-demo-2' }).resolves({ ...gpuEndpoint, EndpointName: 'llm-demo-2' })
    sm.on(DescribeEndpointConfigCommand).resolves(gpuConfig)

    expect((await sagemakerEndpoints.scan(ctx())).map((r) => r.id)).toEqual(['llm-demo', 'llm-demo-2'])
    expect(sm.commandCalls(DescribeEndpointConfigCommand)).toHaveLength(1)
  })

  it('skips an endpoint deleted between the list and the describe call', async () => {
    serveFixtures()
    sm.on(DescribeEndpointCommand, { EndpointName: 'classifier' }).rejects(notFound('endpoint'))

    expect((await sagemakerEndpoints.scan(ctx())).map((r) => r.id)).toEqual(['llm-demo', 'ranker'])
  })

  it('keeps an endpoint whose configuration was deleted, with the instance type unknown', async () => {
    sm.on(ListEndpointsCommand).resolves({ Endpoints: [gpuSummary] })
    sm.on(DescribeEndpointCommand).resolves(gpuEndpoint)
    sm.on(DescribeEndpointConfigCommand).rejects(notFound('endpoint configuration'))

    const [found] = await sagemakerEndpoints.scan(ctx())

    expect(found).toMatchObject({ id: 'llm-demo', attrs: { instanceCount: 2, serverless: false } })
    expect(variantsOf(found?.attrs)).toEqual([
      { name: 'AllTraffic', instanceType: null, instanceCount: 2, serverless: false, shadow: false }
    ])
  })

  it('still counts a variant the configuration does not mention', async () => {
    sm.on(ListEndpointsCommand).resolves({ Endpoints: [gpuSummary] })
    sm.on(DescribeEndpointCommand).resolves({ ...gpuEndpoint, EndpointConfigName: undefined })

    const [found] = await sagemakerEndpoints.scan(ctx())

    expect(sm.commandCalls(DescribeEndpointConfigCommand)).toHaveLength(0)
    expect(variantsOf(found?.attrs)).toEqual([
      { name: 'AllTraffic', instanceType: null, instanceCount: 2, serverless: false, shadow: false }
    ])
  })

  it('keeps a failed endpoint: it stays listed until someone deletes it', async () => {
    sm.on(ListEndpointsCommand).resolves({ Endpoints: [{ ...gpuSummary, EndpointStatus: 'Failed' }] })
    sm.on(DescribeEndpointCommand).resolves({ ...gpuEndpoint, EndpointStatus: 'Failed', ProductionVariants: [] })
    sm.on(DescribeEndpointConfigCommand).resolves(gpuConfig)

    const [found] = await sagemakerEndpoints.scan(ctx())
    expect(found).toMatchObject({ state: 'failed', attrs: { instanceCount: 0 } })
  })

  it.each([
    ['InService', 'in-service'],
    ['OutOfService', 'out-of-service'],
    ['UpdateRollbackFailed', 'update-rollback-failed'],
    ['Creating', 'creating']
  ] as const)('normalises the status %s to %s', async (status, expected) => {
    sm.on(ListEndpointsCommand).resolves({ Endpoints: [gpuSummary] })
    sm.on(DescribeEndpointCommand).resolves({ ...gpuEndpoint, EndpointStatus: status })
    sm.on(DescribeEndpointConfigCommand).resolves(gpuConfig)

    expect((await sagemakerEndpoints.scan(ctx()))[0]?.state).toBe(expected)
  })

  it('reads every page of the endpoint list', async () => {
    serveFixtures()
    sm.on(ListEndpointsCommand)
      .resolves({ Endpoints: [gpuSummary, serverlessSummary], NextToken: 'page-2' })
      .on(ListEndpointsCommand, { NextToken: 'page-2' })
      .resolves({ Endpoints: [abTestSummary] })

    expect((await sagemakerEndpoints.scan(ctx())).map((r) => r.id)).toEqual(['llm-demo', 'classifier', 'ranker'])
    expect(sm.commandCalls(ListEndpointsCommand)).toHaveLength(2)
  })

  it('returns nothing, and describes nothing, for a region with no endpoints', async () => {
    sm.on(ListEndpointsCommand).resolves({ Endpoints: [] })

    expect(await sagemakerEndpoints.scan(ctx())).toEqual([])
    expect(sm.commandCalls(DescribeEndpointCommand)).toHaveLength(0)
  })

  it('skips a list entry with no name', async () => {
    sm.on(ListEndpointsCommand).resolves({ Endpoints: [{ ...gpuSummary, EndpointName: undefined }] })
    expect(await sagemakerEndpoints.scan(ctx())).toEqual([])
    expect(sm.commandCalls(DescribeEndpointCommand)).toHaveLength(0)
  })

  it('calls the region it was asked to scan, and passes the abort signal to every call', async () => {
    serveFixtures()
    const signal = new AbortController().signal
    await sagemakerEndpoints.scan(ctx('ap-south-1', signal))

    const client = clients.get(SageMakerClient, 'ap-south-1')
    const calls = [
      ...sm.commandCalls(ListEndpointsCommand),
      ...sm.commandCalls(DescribeEndpointCommand),
      ...sm.commandCalls(DescribeEndpointConfigCommand)
    ]
    expect(calls).toHaveLength(1 + 3 + 3)
    for (const call of calls) {
      expect(call.thisValue).toBe(client)
      expect((call.args as unknown[])[1]).toMatchObject({ abortSignal: signal })
    }
  })

  it('does not catch other errors from any of the three calls: the engine classifies them', async () => {
    const denied = Object.assign(new Error('nope'), { name: 'AccessDeniedException' })

    sm.on(ListEndpointsCommand).rejects(denied)
    expect(classifyAwsError(await sagemakerEndpoints.scan(ctx()).catch((e: unknown) => e)).code).toBe('access-denied')

    serveFixtures()
    sm.on(DescribeEndpointCommand).rejects(denied)
    expect(classifyAwsError(await sagemakerEndpoints.scan(ctx()).catch((e: unknown) => e)).code).toBe('access-denied')

    serveFixtures()
    sm.on(DescribeEndpointConfigCommand).rejects(denied)
    expect(classifyAwsError(await sagemakerEndpoints.scan(ctx()).catch((e: unknown) => e)).code).toBe('access-denied')
  })

  it('does not mistake other validation errors for a deleted endpoint', async () => {
    serveFixtures()
    sm.on(DescribeEndpointCommand).rejects(
      Object.assign(new Error('1 validation error detected'), { name: 'ValidationException' })
    )
    await expect(sagemakerEndpoints.scan(ctx())).rejects.toThrow('1 validation error detected')
  })

  it('declares its limiter bucket, kind and IAM actions', () => {
    expect(sagemakerEndpoints).toMatchObject({
      kind: 'sagemaker-endpoint',
      service: 'sagemaker',
      requiredActions: ['sagemaker:ListEndpoints', 'sagemaker:DescribeEndpoint', 'sagemaker:DescribeEndpointConfig']
    })
  })
})
