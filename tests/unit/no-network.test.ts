import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import { describe, expect, it } from 'vitest'

// These tests prove the guard in tests/setup/no-network.ts is active.
// If someone removes it from vitest.config.ts, they fail.

function request(mod: typeof http | typeof https, url: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = mod.get(url, resolve)
    req.on('error', reject)
    req.setTimeout(5_000, () => req.destroy(new Error('timed out, guard is not active')))
  })
}

describe('network guard', () => {
  it('blocks https requests to AWS endpoints', async () => {
    await expect(request(https, 'https://ec2.us-east-1.amazonaws.com/')).rejects.toThrow(
      /blocked outbound connection/
    )
  })

  it('blocks plain http requests', async () => {
    await expect(request(http, 'http://example.com/')).rejects.toThrow(/blocked outbound connection/)
  })

  it('blocks fetch', async () => {
    await expect(fetch('https://pricing.us-east-1.amazonaws.com/')).rejects.toSatisfy((err: unknown) =>
      /blocked outbound connection/.test(String((err as { cause?: unknown }).cause ?? err))
    )
  })

  it('allows loopback connections', async () => {
    const server = net.createServer((socket) => socket.end('ok'))
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as net.AddressInfo
    try {
      const reply = await new Promise<string>((resolve, reject) => {
        const socket = net.connect(port, '127.0.0.1')
        socket.on('data', (data) => resolve(data.toString()))
        socket.on('error', reject)
      })
      expect(reply).toBe('ok')
    } finally {
      server.close()
    }
  })
})
