// The one place AWS SDK clients are created.
//
// - Credentials come from the user's existing AWS profile through the SDK's
//   standard provider chain (keys, SSO, assumed roles, credential_process).
//   The app never reads, stores or logs the keys itself.
// - One client per (service, region), reused for the life of the factory.
// - Every client retries with `adaptive` mode, which slows down when AWS
//   starts throttling, up to 5 attempts.

import type { STSClientConfig } from '@aws-sdk/client-sts'
import { fromNodeProviderChain } from '@aws-sdk/credential-providers'

/** Global calls (STS, DescribeRegions) go here. Always enabled in every account. */
export const HOME_REGION = 'us-east-1'

const MAX_ATTEMPTS = 5
/** Fetch new credentials when the current ones have less than this left. */
const REFRESH_BEFORE_EXPIRY_MS = 5 * 60_000

export interface Credentials {
  accessKeyId: string
  secretAccessKey: string
  sessionToken?: string
  expiration?: Date
}
export type CredentialProvider = () => Promise<Credentials>

/** The config every client is built with. */
export interface ClientConfig {
  region: string
  credentials: CredentialProvider
  retryMode: 'adaptive'
  maxAttempts: number
  requestHandler?: RequestHandler
}

/** The SDK's HTTP layer. Only tests supply one. */
export type RequestHandler = NonNullable<STSClientConfig['requestHandler']>

interface AwsClient {
  destroy(): void
}
/** Any AWS SDK v3 client class, e.g. `EC2Client`. */
export type ClientConstructor<T extends AwsClient> = new (config: ClientConfig) => T

export interface ClientFactory {
  /** The AWS profile these clients sign requests with. */
  readonly profile: string
  /** The client for a service in a region. Created on first use, then reused. */
  get<T extends AwsClient>(service: ClientConstructor<T>, region: string): T
  /** Closes every client. Call on quit and when the profile changes. */
  destroy(): void
}

export interface ClientFactoryOptions {
  profile: string
  /** Replaces the profile's credential chain. For tests. */
  credentials?: CredentialProvider
  /** Replaces the HTTP layer, keeping signing and retries real. For tests. */
  requestHandler?: RequestHandler
}

export function createClientFactory(options: ClientFactoryOptions): ClientFactory {
  const credentials = memoizeCredentials(options.credentials ?? fromNodeProviderChain({ profile: options.profile }))
  const clients = new Map<ClientConstructor<AwsClient>, Map<string, AwsClient>>()

  return {
    profile: options.profile,

    get<T extends AwsClient>(service: ClientConstructor<T>, region: string): T {
      let byRegion = clients.get(service)
      if (!byRegion) {
        byRegion = new Map()
        clients.set(service, byRegion)
      }
      let client = byRegion.get(region)
      if (!client) {
        client = new service({
          region,
          credentials,
          retryMode: 'adaptive',
          maxAttempts: MAX_ATTEMPTS,
          ...(options.requestHandler ? { requestHandler: options.requestHandler } : {})
        })
        byRegion.set(region, client)
      }
      return client as T
    },

    destroy(): void {
      for (const byRegion of clients.values()) {
        for (const client of byRegion.values()) client.destroy()
      }
      clients.clear()
    }
  }
}

/**
 * Makes all clients share one credential lookup. Without this each of the
 * ~100 clients (services x regions) would resolve credentials separately,
 * which for SSO means one network call each.
 *
 * Concurrent callers share the lookup in flight. A result is reused until
 * shortly before it expires. A failure is not kept, so the next call retries
 * (for example after the user runs `aws sso login`).
 */
export function memoizeCredentials(provider: CredentialProvider, now: () => number = Date.now): CredentialProvider {
  type Entry = { promise: Promise<Credentials>; settled: boolean; expiresAt: number | null }
  let current: Entry | null = null

  return () => {
    if (current) {
      const fresh = current.expiresAt === null || current.expiresAt - now() > REFRESH_BEFORE_EXPIRY_MS
      if (!current.settled || fresh) return current.promise
    }
    const entry: Entry = { promise: provider(), settled: false, expiresAt: null }
    current = entry
    entry.promise.then(
      (credentials) => {
        entry.settled = true
        entry.expiresAt = credentials.expiration?.getTime() ?? null
      },
      () => {
        if (current === entry) current = null
      }
    )
    return entry.promise
  }
}
