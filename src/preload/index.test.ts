import { beforeAll, describe, expect, it, vi } from 'vitest'
import { API_EVENTS, API_METHODS } from '../shared/ipc'

const electron = vi.hoisted(() => ({
  exposeInMainWorld: vi.fn(),
  invoke: vi.fn(async () => ({ ok: true, value: null })),
  on: vi.fn(),
  removeListener: vi.fn()
}))

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: electron.exposeInMainWorld },
  ipcRenderer: { invoke: electron.invoke, on: electron.on, removeListener: electron.removeListener }
}))

type Api = Record<string, (...args: unknown[]) => unknown>
let api: Api
// Captured once: the config resets mock call history between tests.
let exposeCalls: unknown[][]

beforeAll(async () => {
  await import('./index')
  exposeCalls = [...electron.exposeInMainWorld.mock.calls]
  api = exposeCalls[0]?.[1] as Api
})

describe('preload bridge', () => {
  it('exposes one object named watchdog', () => {
    expect(exposeCalls).toEqual([['watchdog', expect.any(Object)]])
  })

  it('exposes exactly the contract: no raw ipcRenderer, no extra methods', () => {
    expect(Object.keys(api).sort()).toEqual(
      ['apiVersion', ...Object.keys(API_METHODS), ...Object.keys(API_EVENTS)].sort()
    )
    expect(Object.isFrozen(api)).toBe(true)
  })

  it('sends each method to its own fixed channel', async () => {
    for (const [method, channel] of Object.entries(API_METHODS)) {
      electron.invoke.mockClear()
      await api[method]!({ any: 'input' })
      expect(electron.invoke).toHaveBeenCalledExactlyOnceWith(channel, { any: 'input' })
    }
  })

  it('passes only the first argument, so the page cannot smuggle a channel name', async () => {
    electron.invoke.mockClear()
    await api['selectProfile']!({ profile: 'a' }, 'actions:execute', { token: 'x' })
    expect(electron.invoke).toHaveBeenCalledExactlyOnceWith('profiles:select', { profile: 'a' })
  })

  it('subscribes to events without handing the page the Electron event object', () => {
    const listener = vi.fn()
    const unsubscribe = api['onScanProgress']!(listener) as () => void
    const [channel, wrapped] = electron.on.mock.calls.at(-1) as [string, (event: unknown, payload: unknown) => void]
    expect(channel).toBe('scan:progress')

    wrapped({ sender: 'electron internals' }, { scanId: 's1', done: 1, total: 4 })
    expect(listener).toHaveBeenCalledExactlyOnceWith({ scanId: 's1', done: 1, total: 4 })

    unsubscribe()
    expect(electron.removeListener).toHaveBeenCalledExactlyOnceWith('scan:progress', wrapped)
  })
})
