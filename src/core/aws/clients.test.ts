import { EC2Client } from '@aws-sdk/client-ec2'
import { STSClient } from '@aws-sdk/client-sts'
import { describe, expect, it, vi } from 'vitest'
import { createClientFactory, memoizeCredentials, type Credentials } from './clients'

const creds = (expiration?: Date): Credentials => ({
  accessKeyId: 'AKIAFAKEFAKEFAKEFAKE',
  secretAccessKey: 'fake-secret',
  ...(expiration ? { expiration } : {})
})

describe('createClientFactory', () => {
  const factory = () => createClientFactory({ profile: 'test', credentials: async () => creds() })

  it('returns the same client for the same service and region', () => {
    const clients = factory()
    expect(clients.get(EC2Client, 'eu-west-1')).toBe(clients.get(EC2Client, 'eu-west-1'))
  })

  it('returns different clients for different regions and services', () => {
    const clients = factory()
    const ec2Ireland = clients.get(EC2Client, 'eu-west-1')
    expect(clients.get(EC2Client, 'us-east-1')).not.toBe(ec2Ireland)
    expect(clients.get(STSClient, 'eu-west-1')).not.toBe(ec2Ireland)
    expect(clients.get(STSClient, 'eu-west-1')).toBeInstanceOf(STSClient)
  })

  it('configures the region, adaptive retry and five attempts', async () => {
    const client = factory().get(EC2Client, 'ap-south-1')
    expect(await client.config.region()).toBe('ap-south-1')
    const retryMode = client.config.retryMode
    expect(typeof retryMode === 'function' ? await retryMode() : retryMode).toBe('adaptive')
    expect(await client.config.maxAttempts()).toBe(5)
  })

  it('remembers which profile it was built for', () => {
    expect(factory().profile).toBe('test')
  })

  it('resolves credentials once for all clients', async () => {
    const provider = vi.fn(async () => creds())
    const clients = createClientFactory({ profile: 'test', credentials: provider })
    await clients.get(EC2Client, 'eu-west-1').config.credentials()
    await clients.get(EC2Client, 'us-east-1').config.credentials()
    await clients.get(STSClient, 'us-east-1').config.credentials()
    expect(provider).toHaveBeenCalledTimes(1)
  })

  it('destroys every client and starts fresh afterwards', () => {
    const clients = factory()
    const ec2 = clients.get(EC2Client, 'eu-west-1')
    const sts = clients.get(STSClient, 'us-east-1')
    const destroyEc2 = vi.spyOn(ec2, 'destroy')
    const destroySts = vi.spyOn(sts, 'destroy')
    clients.destroy()
    expect(destroyEc2).toHaveBeenCalledOnce()
    expect(destroySts).toHaveBeenCalledOnce()
    expect(clients.get(EC2Client, 'eu-west-1')).not.toBe(ec2)
  })
})

describe('memoizeCredentials', () => {
  it('shares one in-flight lookup between concurrent callers', async () => {
    const provider = vi.fn(async () => creds())
    const get = memoizeCredentials(provider)
    await Promise.all([get(), get(), get()])
    expect(provider).toHaveBeenCalledTimes(1)
  })

  it('keeps credentials that do not expire', async () => {
    const provider = vi.fn(async () => creds())
    const get = memoizeCredentials(provider)
    await get()
    await get()
    expect(provider).toHaveBeenCalledTimes(1)
  })

  it('refreshes credentials shortly before they expire', async () => {
    let now = 0
    const provider = vi.fn(async () => creds(new Date(now + 60 * 60_000)))
    const get = memoizeCredentials(provider, () => now)
    await get()
    now = 50 * 60_000 // 10 minutes left: still fine
    await get()
    expect(provider).toHaveBeenCalledTimes(1)
    now = 57 * 60_000 // 3 minutes left: refresh
    await get()
    expect(provider).toHaveBeenCalledTimes(2)
  })

  it('does not cache a failure', async () => {
    const provider = vi
      .fn<() => Promise<Credentials>>()
      .mockRejectedValueOnce(new Error('SSO session expired'))
      .mockResolvedValueOnce(creds())
    const get = memoizeCredentials(provider)
    await expect(get()).rejects.toThrow('SSO session expired')
    await expect(get()).resolves.toMatchObject({ accessKeyId: 'AKIAFAKEFAKEFAKEFAKE' })
    expect(provider).toHaveBeenCalledTimes(2)
  })
})
