// Turns whatever an AWS SDK call threw into one of six codes the rest of the
// app acts on. Scanners never catch errors; the scan engine catches them and
// calls this.

import type { ScanErrorCode } from '../../shared/types'

export interface ClassifiedError {
  code: ScanErrorCode
  /** The original message, shortened. Shown in the scan errors panel. */
  message: string
}

const MAX_MESSAGE_LENGTH = 500

// The profile works, but it is not allowed to make this call.
const ACCESS_DENIED = new Set(['AccessDenied', 'AccessDeniedException', 'UnauthorizedOperation', 'NotAuthorized'])

// Still throttled after the SDK's own adaptive retries.
const THROTTLED = new Set([
  'Throttling',
  'ThrottlingException',
  'ThrottledException',
  'RequestLimitExceeded',
  'RequestThrottled',
  'RequestThrottledException',
  'TooManyRequestsException',
  'EC2ThrottledException',
  'SlowDown',
  'PriorRequestNotComplete'
])

// The region or service is not switched on for this account.
const REGION_DISABLED = new Set(['OptInRequired'])

// The credentials themselves do not work: the user has to sign in again or
// fix the profile. The first group comes back from AWS; the last three are
// raised locally by the credential chain (expired SSO session, profile that
// cannot be loaded) or by the SSO portal when it rejects the cached token.
const AUTH_EXPIRED = new Set([
  'ExpiredToken',
  'ExpiredTokenException',
  'RequestExpired',
  'InvalidClientTokenId',
  'UnrecognizedClientException',
  'AuthFailure',
  'CredentialsProviderError',
  'TokenProviderError',
  'UnauthorizedException'
])

const NETWORK_NAMES = new Set(['TimeoutError', 'RequestTimeout', 'NetworkingError'])
const NETWORK_CODES = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'EPIPE'
])

type ErrorLike = {
  name?: unknown
  Code?: unknown
  code?: unknown
  message?: unknown
  cause?: unknown
  $retryable?: { throttling?: unknown }
  $metadata?: { httpStatusCode?: unknown }
}

/** Error identifiers found on the error, e.g. "Client.UnauthorizedOperation" -> "UnauthorizedOperation". */
function identifiers(err: ErrorLike): string[] {
  return [err.name, err.Code, err.code]
    .filter((value): value is string => typeof value === 'string')
    .map((value) => value.replace(/^(Client|Server)\./, ''))
}

/** Whether the error is the AWS error called `name`, e.g. "DryRunOperation". */
export function hasErrorName(error: unknown, name: string): boolean {
  return error !== null && typeof error === 'object' && identifiers(error as ErrorLike).includes(name)
}

function codeOf(err: ErrorLike): ScanErrorCode | null {
  const ids = identifiers(err)
  const any = (set: Set<string>) => ids.some((id) => set.has(id))

  if (any(AUTH_EXPIRED)) return 'auth-expired'
  if (any(ACCESS_DENIED)) return 'access-denied'
  if (any(REGION_DISABLED)) return 'region-disabled'
  if (any(THROTTLED) || err.$retryable?.throttling === true || err.$metadata?.httpStatusCode === 429) return 'throttled'
  if (any(NETWORK_NAMES) || any(NETWORK_CODES)) return 'network'
  return null
}

export function classifyAwsError(error: unknown): ClassifiedError {
  if (error === null || typeof error !== 'object') {
    return { code: 'unknown', message: typeof error === 'string' && error ? error : 'Unknown error' }
  }
  const err = error as ErrorLike
  // Network failures are often wrapped: the socket error is the `cause`.
  const cause = err.cause !== null && typeof err.cause === 'object' ? (err.cause as ErrorLike) : null
  const code = codeOf(err) ?? (cause ? codeOf(cause) : null) ?? 'unknown'

  const text = typeof err.message === 'string' && err.message ? err.message : (identifiers(err)[0] ?? 'Unknown error')
  return { code, message: text.slice(0, MAX_MESSAGE_LENGTH) }
}
