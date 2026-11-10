// Throttling, end to end through the real SDK retry code: only the HTTP layer
// is replaced. (aws-sdk-client-mock replaces `client.send`, which skips the
// retry middleware, so it cannot show that retries happen.)

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createClientFactory } from '../aws/clients'
import { ec2Instances } from '../scanners/ec2Instances'
import { createScanEngine } from './engine'

const THROTTLED = {
  statusCode: 503,
  body: `<?xml version="1.0" encoding="UTF-8"?>
<Response><Errors><Error><Code>RequestLimitExceeded</Code><Message>Request limit exceeded.</Message></Error></Errors><RequestID>req-1</RequestID></Response>`
}

const ONE_INSTANCE = {
  statusCode: 200,
  body: `<?xml version="1.0" encoding="UTF-8"?>
<DescribeInstancesResponse xmlns="http://ec2.amazonaws.com/doc/2016-11-15/">
  <requestId>req-2</requestId>
  <reservationSet><item>
    <reservationId>r-0aaa1111bbbb22223</reservationId>
    <ownerId>111122223333</ownerId>
    <instancesSet><item>
      <instanceId>i-0aaa1111bbbb22223</instanceId>
      <instanceState><code>16</code><name>running</name></instanceState>
      <instanceType>t3.micro</instanceType>
    </item></instancesSet>
  </item></reservationSet>
</DescribeInstancesResponse>`
}

const REGIONS = {
  statusCode: 200,
  body: `<?xml version="1.0" encoding="UTF-8"?>
<DescribeRegionsResponse xmlns="http://ec2.amazonaws.com/doc/2016-11-15/">
  <requestId>req-3</requestId>
  <regionInfo><item>
    <regionName>us-east-1</regionName>
    <regionEndpoint>ec2.us-east-1.amazonaws.com</regionEndpoint>
    <optInStatus>opt-in-not-required</optInStatus>
  </item></regionInfo>
</DescribeRegionsResponse>`
}

const IDENTITY = {
  statusCode: 200,
  body: `<GetCallerIdentityResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/">
  <GetCallerIdentityResult>
    <Arn>arn:aws:iam::111122223333:user/watchdog</Arn>
    <UserId>AIDAFAKEFAKEFAKEFAKE</UserId>
    <Account>111122223333</Account>
  </GetCallerIdentityResult>
  <ResponseMetadata><RequestId>req-4</RequestId></ResponseMetadata>
</GetCallerIdentityResponse>`
}

type Canned = { statusCode: number; body: string }

/** Stands in for the HTTP layer. Answers DescribeInstances with `describeInstances(attempt)`. */
function fakeHttp(describeInstances: (attempt: number) => Canned) {
  let attempts = 0
  return {
    get describeInstancesAttempts() {
      return attempts
    },
    handler: {
      metadata: { handlerProtocol: 'http/1.1' },
      updateHttpClientConfig() {},
      httpHandlerConfigs: () => ({}),
      destroy() {},
      async handle(request: { body?: unknown }) {
        const action = /Action=(\w+)/.exec(String(request.body))?.[1]
        const canned =
          action === 'GetCallerIdentity' ? IDENTITY : action === 'DescribeRegions' ? REGIONS : describeInstances(++attempts)
        return {
          response: {
            statusCode: canned.statusCode,
            headers: { 'content-type': 'text/xml;charset=UTF-8' },
            body: new TextEncoder().encode(canned.body)
          }
        }
      }
    }
  }
}

function scanWith(http: ReturnType<typeof fakeHttp>) {
  const clients = createClientFactory({
    profile: 'hackathon',
    credentials: async () => ({ accessKeyId: 'AKIAFAKEFAKEFAKEFAKE', secretAccessKey: 'fake' }),
    requestHandler: http.handler
  })
  return createScanEngine({ clients, scanners: [ec2Instances], loadPrevious: () => [] }).run()
}

/** The SDK waits between retries. Fake time is moved on until the scan settles. */
async function settle<T>(promise: Promise<T>): Promise<T> {
  let settled = false
  const tracked = promise.finally(() => (settled = true))
  tracked.catch(() => {})
  for (let i = 0; i < 200 && !settled; i++) await vi.advanceTimersByTimeAsync(1_000)
  return tracked
}

beforeEach(() => void vi.useFakeTimers())
afterEach(() => void vi.useRealTimers())

describe('throttling through the real SDK retry code', () => {
  it('retries a throttled call and uses the answer once AWS gives one', async () => {
    const http = fakeHttp((attempt) => (attempt <= 2 ? THROTTLED : ONE_INSTANCE))
    const scan = await settle(scanWith(http))

    expect(http.describeInstancesAttempts).toBe(3)
    expect(scan.errors).toEqual([])
    expect(scan.resources.map((r) => [r.id, r.state, r.stale])).toEqual([['i-0aaa1111bbbb22223', 'running', false]])
  })

  it('gives up after five attempts and reports the scanner as throttled', async () => {
    const http = fakeHttp(() => THROTTLED)
    const scan = await settle(scanWith(http))

    expect(http.describeInstancesAttempts).toBe(5)
    expect(scan.resources).toEqual([])
    expect(scan.errors).toEqual([
      { scanner: 'ec2-instance', region: 'us-east-1', code: 'throttled', message: 'Request limit exceeded.' }
    ])
  })
})
