import type { IpcMainInvokeEvent } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import { API_METHODS, IPC_CHANNELS, type IpcChannel, type IpcResult } from '../shared/ipc'
import { fail, ok, registerIpcHandlers, type IpcHandlers } from './ipcHandlers'

type Listener = (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<IpcResult<unknown>>

const TRUSTED = { trusted: true } as unknown as IpcMainInvokeEvent
const UNTRUSTED = { trusted: false } as unknown as IpcMainInvokeEvent
const KEY = '111122223333:ec2-instance:eu-west-1:i-0abc'

/** Handlers that record their input and succeed. */
function spyHandlers(): IpcHandlers {
  const entries = IPC_CHANNELS.map((channel) => [channel, vi.fn(async () => ok(null))])
  return Object.fromEntries(entries) as unknown as IpcHandlers
}

function setup(handlers: IpcHandlers = spyHandlers()) {
  const listeners = new Map<string, Listener>()
  const onError = vi.fn()
  registerIpcHandlers(
    { handle: (channel, listener) => void listeners.set(channel, listener as Listener) },
    { isTrustedSender: (event) => (event as unknown as { trusted: boolean }).trusted, handlers, onError }
  )
  const invoke = (channel: IpcChannel, ...args: unknown[]) => listeners.get(channel)!(TRUSTED, ...args)
  return { listeners, handlers, invoke, onError }
}

describe('registerIpcHandlers', () => {
  it('registers exactly the channels in the contract', () => {
    const { listeners } = setup()
    expect([...listeners.keys()].sort()).toEqual(Object.values(API_METHODS).sort())
  })

  it('refuses a sender that is not the app window, before validating or handling', async () => {
    const { listeners, handlers } = setup()
    for (const channel of IPC_CHANNELS) {
      const result = await listeners.get(channel)!(UNTRUSTED)
      expect(result).toMatchObject({ ok: false, error: { code: 'forbidden' } })
      expect(handlers[channel]).not.toHaveBeenCalled()
    }
  })

  const malformed: Array<[IpcChannel, unknown]> = [
    ['app:getState', { unexpected: true }],
    ['profiles:list', 'x'],
    ['scan:run', 0],
    ['scan:getLatest', null],
    ['profiles:select', undefined],
    ['profiles:select', {}],
    ['profiles:select', { profile: '' }],
    ['profiles:select', { profile: 42 }],
    ['profiles:select', { profile: 'bad]name' }],
    ['profiles:select', { profile: 'line\nbreak' }],
    ['profiles:select', { profile: 'x'.repeat(200) }],
    ['profiles:select', { profile: 'ok', extra: 1 }],
    ['flags:dismiss', { flagId: 5 }],
    ['flags:dismiss', { flagId: 'f1', hours: 0 }],
    ['flags:dismiss', { flagId: 'f1', hours: 1.5 }],
    ['flags:dismiss', { flagId: 'f1', hours: 1e9 }],
    ['flags:dismiss', { flagId: 'f1', hours: '24' }],
    ['settings:update', { scanIntervalMinutes: 1 }],
    ['settings:update', { scanIntervalMinutes: 100000 }],
    ['settings:update', { scanIntervalMinutes: 15.5 }],
    ['settings:update', { startAtLogin: 'yes' }],
    ['settings:update', { actionsEnabled: true }],
    ['settings:update', { rules: { 'nat-gateway': { enabled: true } } }],
    ['settings:update', { rules: { 'nat-gateway': { enabled: true, params: { hours: 'many' } } } }],
    ['settings:update', []],
    ['resource:manualSteps', { resourceKey: 'https://evil.example/' }],
    ['resource:manualSteps', { resourceKey: '' }],
    ['resource:openConsole', { url: 'https://evil.example/' }],
    ['resource:openConsole', { resourceKey: KEY, url: 'https://evil.example/' }],
    ['actions:preview', { resourceKey: KEY, action: 'terminate-ec2' }],
    ['actions:preview', { resourceKey: KEY }],
    ['actions:execute', { token: '' }],
    ['actions:execute', { token: 'x'.repeat(1000) }],
    ['actions:execute', { resourceKey: KEY, action: 'stop-ec2' }],
    ['actions:setEnabled', undefined],
    ['actions:setEnabled', { enabled: 'yes' }],
    ['actions:setEnabled', { enabled: true, confirmed: true }]
  ]

  it.each(malformed)('rejects malformed input on %s: %j', async (channel, input) => {
    const { invoke, handlers } = setup()
    const result = await invoke(channel, input)
    expect(result).toMatchObject({ ok: false, error: { code: 'invalid-input' } })
    expect(handlers[channel]).not.toHaveBeenCalled()
  })

  it('does not echo rejected values back in the error message', async () => {
    const { invoke } = setup()
    const result = await invoke('profiles:select', { profile: 'secret]value' })
    expect(JSON.stringify(result)).not.toContain('secret]value')
  })

  it('rejects more than one argument', async () => {
    const { invoke, handlers } = setup()
    const result = await invoke('profiles:select', { profile: 'default' }, 'second')
    expect(result).toMatchObject({ ok: false, error: { code: 'invalid-input' } })
    expect(handlers['profiles:select']).not.toHaveBeenCalled()
  })

  const valid: Array<[IpcChannel, unknown]> = [
    ['app:getState', undefined],
    ['profiles:select', { profile: 'my sso-profile.dev' }],
    ['flags:dismiss', { flagId: 'f1' }],
    ['flags:dismiss', { flagId: 'f1', hours: 24 }],
    ['settings:update', {}],
    ['settings:update', { scanIntervalMinutes: 30, rules: { 'running-long': { enabled: false, params: { hours: 48 } } } }],
    ['settings:update', { profile: null }],
    ['resource:manualSteps', { resourceKey: KEY }],
    ['resource:openConsole', { resourceKey: KEY }],
    ['actions:preview', { resourceKey: KEY, action: 'stop-rds' }],
    ['actions:execute', { token: 'a'.repeat(32) }],
    ['actions:setEnabled', { enabled: true }]
  ]

  it.each(valid)('passes valid input on %s to the handler: %j', async (channel, input) => {
    const { invoke, handlers } = setup()
    expect(await invoke(channel, input)).toEqual({ ok: true, value: null })
    expect(handlers[channel]).toHaveBeenCalledExactlyOnceWith(input)
  })

  it('returns a typed failure from a handler unchanged', async () => {
    const handlers = spyHandlers()
    handlers['profiles:select'] = async () => fail('auth-expired', 'Run: aws sso login --profile x')
    const { invoke } = setup(handlers)
    expect(await invoke('profiles:select', { profile: 'x' })).toEqual({
      ok: false,
      error: { code: 'auth-expired', message: 'Run: aws sso login --profile x' }
    })
  })

  it('turns a thrown error into a generic failure and reports it to the main process only', async () => {
    const handlers = spyHandlers()
    const boom = new Error('SQLITE_CORRUPT at C:\\Users\\someone\\AppData')
    handlers['scan:run'] = async () => {
      throw boom
    }
    const { invoke, onError } = setup(handlers)
    const result = await invoke('scan:run')
    expect(result).toMatchObject({ ok: false, error: { code: 'internal' } })
    expect(JSON.stringify(result)).not.toContain('SQLITE_CORRUPT')
    expect(onError).toHaveBeenCalledExactlyOnceWith('scan:run', boom)
  })
})
