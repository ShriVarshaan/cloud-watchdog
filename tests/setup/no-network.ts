// Vitest setup file: blocks every outbound TCP connection except loopback.
//
// Tests must never call real AWS. Instead of trusting every test to mock
// correctly, this patches the one place all Node networking goes through
// (net.Socket#connect, used by http, https, tls, fetch and the AWS SDK).
// A connection to anything but localhost fails with a clear error.

import net from 'node:net'

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])

type ConnectTarget = { kind: 'pipe' } | { kind: 'tcp'; host: string }

function targetOf(args: unknown[]): ConnectTarget {
  // Node's own callers pass an already-normalised [options, callback] array.
  const first = Array.isArray(args[0]) ? (args[0] as unknown[])[0] : args[0]

  if (first !== null && typeof first === 'object') {
    const options = first as { path?: unknown; host?: unknown }
    if (typeof options.path === 'string') return { kind: 'pipe' }
    return { kind: 'tcp', host: typeof options.host === 'string' ? options.host : 'localhost' }
  }
  if (typeof first === 'number' || (typeof first === 'string' && /^\d+$/.test(first))) {
    return { kind: 'tcp', host: typeof args[1] === 'string' ? args[1] : 'localhost' }
  }
  // A non-numeric string is a named pipe or Unix socket path.
  return { kind: 'pipe' }
}

function isLoopback(host: string): boolean {
  return LOOPBACK_HOSTS.has(host.toLowerCase()) || host.startsWith('127.')
}

const realConnect = net.Socket.prototype.connect

net.Socket.prototype.connect = function guardedConnect(this: net.Socket, ...args: unknown[]) {
  const target = targetOf(args)
  if (target.kind === 'tcp' && !isLoopback(target.host)) {
    const error = new Error(
      `Test network guard: blocked outbound connection to ${target.host}. ` +
        'Tests must use SDK mocks or recorded fixtures, never real AWS.'
    )
    process.nextTick(() => this.destroy(error))
    return this
  }
  return (realConnect as (...a: unknown[]) => net.Socket).apply(this, args)
} as typeof net.Socket.prototype.connect
