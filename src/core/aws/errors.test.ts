import { describe, expect, it } from 'vitest'
import type { ScanErrorCode } from '../../shared/types'
import { classifyAwsError } from './errors'

/** An error shaped like the ones AWS SDK v3 throws. */
function awsError(name: string, extra: Record<string, unknown> = {}): Error {
  return Object.assign(new Error(`${name}: simulated`), { name, $fault: 'client', $metadata: {} }, extra)
}

describe('classifyAwsError', () => {
  const byName: Array<[string, ScanErrorCode]> = [
    // Permission problems: the profile works but may not make this call.
    ['AccessDenied', 'access-denied'],
    ['AccessDeniedException', 'access-denied'],
    ['UnauthorizedOperation', 'access-denied'],
    ['Client.UnauthorizedOperation', 'access-denied'],
    // Throttling that survived the SDK's own retries.
    ['ThrottlingException', 'throttled'],
    ['Throttling', 'throttled'],
    ['RequestLimitExceeded', 'throttled'],
    ['TooManyRequestsException', 'throttled'],
    // Region or service not switched on for the account.
    ['OptInRequired', 'region-disabled'],
    // Credentials that no longer work.
    ['ExpiredToken', 'auth-expired'],
    ['ExpiredTokenException', 'auth-expired'],
    ['RequestExpired', 'auth-expired'],
    ['InvalidClientTokenId', 'auth-expired'],
    ['UnrecognizedClientException', 'auth-expired'],
    ['AuthFailure', 'auth-expired'],
    // Thrown by the credential chain before any request is made:
    // expired SSO session, missing profile, no credentials at all.
    ['CredentialsProviderError', 'auth-expired'],
    ['TokenProviderError', 'auth-expired'],
    // Returned by the SSO portal when the cached SSO token is rejected.
    ['UnauthorizedException', 'auth-expired'],
    ['TimeoutError', 'network'],
    ['SomethingNobodyHasSeen', 'unknown']
  ]

  it.each(byName)('maps %s to %s', (name, code) => {
    expect(classifyAwsError(awsError(name)).code).toBe(code)
  })

  it('reads the code from `Code` when the name is generic (older XML services)', () => {
    expect(classifyAwsError(awsError('Error', { Code: 'RequestLimitExceeded' })).code).toBe('throttled')
  })

  it('treats any error the SDK marks as throttling as throttled', () => {
    expect(classifyAwsError(awsError('BrandNewThrottle', { $retryable: { throttling: true } })).code).toBe('throttled')
  })

  it('treats HTTP 429 as throttled', () => {
    expect(classifyAwsError(awsError('Whatever', { $metadata: { httpStatusCode: 429 } })).code).toBe('throttled')
  })

  it.each(['ENOTFOUND', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN'])(
    'maps socket error %s to network',
    (code) => {
      expect(classifyAwsError(Object.assign(new Error('socket'), { code })).code).toBe('network')
    }
  )

  it('finds a network failure wrapped as the cause of another error', () => {
    const wrapped = new Error('fetch failed', { cause: Object.assign(new Error('dns'), { code: 'ENOTFOUND' }) })
    expect(classifyAwsError(wrapped).code).toBe('network')
  })

  it('recognises the SDK message for an expired SSO session', () => {
    const err = awsError('CredentialsProviderError')
    err.message =
      'The SSO session associated with this profile has expired. To refresh this SSO session run aws sso login with the corresponding profile.'
    const result = classifyAwsError(err)
    expect(result.code).toBe('auth-expired')
    expect(result.message).toContain('aws sso login')
  })

  it('keeps the AWS message so the UI can show what was denied', () => {
    const err = awsError('UnauthorizedOperation')
    err.message = 'You are not authorized to perform this operation: ec2:DescribeInstances'
    expect(classifyAwsError(err).message).toBe('You are not authorized to perform this operation: ec2:DescribeInstances')
  })

  it('caps very long messages', () => {
    const err = awsError('AccessDenied')
    err.message = 'x'.repeat(5000)
    expect(classifyAwsError(err).message.length).toBeLessThanOrEqual(500)
  })

  it.each([undefined, null, 'a string', 42, {}])('never throws on a non-error value: %s', (value) => {
    const result = classifyAwsError(value)
    expect(result.code).toBe('unknown')
    expect(typeof result.message).toBe('string')
    expect(result.message.length).toBeGreaterThan(0)
  })
})
