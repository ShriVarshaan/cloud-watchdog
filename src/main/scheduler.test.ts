import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createScheduler, MAX_BACKOFF_MS, type ScanOutcome } from './scheduler'

const MINUTE = 60_000

beforeEach(() => void vi.useFakeTimers())
afterEach(() => void vi.useRealTimers())

/** A scan function whose outcomes the test sets, and which can be held open. */
function fakeScan(outcomes: ScanOutcome[] = []) {
  let calls = 0
  let release: (() => void) | null = null
  let hold = false
  const run = async (): Promise<ScanOutcome> => {
    calls++
    if (hold) await new Promise<void>((resolve) => (release = resolve))
    return outcomes.shift() ?? 'ok'
  }
  return {
    run,
    calls: () => calls,
    holdNext: () => (hold = true),
    finish: () => {
      hold = false
      release?.()
    }
  }
}

describe('scheduler', () => {
  it('scans on start and then every interval', async () => {
    const scan = fakeScan()
    const scheduler = createScheduler({ run: scan.run, intervalMinutes: () => 15 })
    scheduler.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(scan.calls()).toBe(1)

    await vi.advanceTimersByTimeAsync(15 * MINUTE - 1)
    expect(scan.calls()).toBe(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(scan.calls()).toBe(2)
    await vi.advanceTimersByTimeAsync(15 * MINUTE)
    expect(scan.calls()).toBe(3)
    scheduler.stop()
  })

  it('counts the interval from the end of a scan, so scans never overlap', async () => {
    const scan = fakeScan()
    scan.holdNext()
    const scheduler = createScheduler({ run: scan.run, intervalMinutes: () => 15 })
    scheduler.start()

    await vi.advanceTimersByTimeAsync(40 * MINUTE)
    expect(scan.calls()).toBe(1)
    scan.finish()
    await vi.advanceTimersByTimeAsync(15 * MINUTE)
    expect(scan.calls()).toBe(2)
    scheduler.stop()
  })

  it('scans straight away on resume from sleep, and restarts the interval from there', async () => {
    const scan = fakeScan()
    const scheduler = createScheduler({ run: scan.run, intervalMinutes: () => 15 })
    scheduler.start()
    await vi.advanceTimersByTimeAsync(10 * MINUTE)

    scheduler.onResume()
    await vi.advanceTimersByTimeAsync(0)
    expect(scan.calls()).toBe(2)
    await vi.advanceTimersByTimeAsync(14 * MINUTE)
    expect(scan.calls()).toBe(2)
    await vi.advanceTimersByTimeAsync(1 * MINUTE)
    expect(scan.calls()).toBe(3)
    scheduler.stop()
  })

  it('joins a scan in progress instead of starting a second one', async () => {
    const scan = fakeScan()
    scan.holdNext()
    const scheduler = createScheduler({ run: scan.run, intervalMinutes: () => 15 })
    scheduler.start()
    scheduler.runNow()
    scheduler.onResume()
    await vi.advanceTimersByTimeAsync(0)
    expect(scan.calls()).toBe(1)
    scan.finish()
    scheduler.stop()
  })

  it('backs off after the sign-in expires: twice the interval, then four times, up to 4 hours', async () => {
    const scan = fakeScan(['auth-expired', 'auth-expired', 'auth-expired', 'auth-expired', 'auth-expired', 'auth-expired'])
    const scheduler = createScheduler({ run: scan.run, intervalMinutes: () => 15 })
    scheduler.start()
    await vi.advanceTimersByTimeAsync(0)

    const gaps: number[] = []
    for (let i = 0; i < 5; i++) {
      const before = Date.now()
      const at = scan.calls()
      while (scan.calls() === at) await vi.advanceTimersByTimeAsync(MINUTE)
      gaps.push((Date.now() - before) / MINUTE)
    }
    expect(gaps).toEqual([30, 60, 120, 240, 240])
    expect(MAX_BACKOFF_MS).toBe(240 * MINUTE)
    scheduler.stop()
  })

  it('goes back to the normal interval once a scan works again', async () => {
    const scan = fakeScan(['auth-expired', 'ok'])
    const scheduler = createScheduler({ run: scan.run, intervalMinutes: () => 15 })
    scheduler.start()
    await vi.advanceTimersByTimeAsync(30 * MINUTE)
    expect(scan.calls()).toBe(2)
    await vi.advanceTimersByTimeAsync(15 * MINUTE)
    expect(scan.calls()).toBe(3)
    scheduler.stop()
  })

  it('does not back off for other failures', async () => {
    const scan = fakeScan(['failed', 'failed'])
    const scheduler = createScheduler({ run: scan.run, intervalMinutes: () => 15 })
    scheduler.start()
    await vi.advanceTimersByTimeAsync(30 * MINUTE)
    expect(scan.calls()).toBe(3)
    scheduler.stop()
  })

  it('keeps going when the scan function throws', async () => {
    let calls = 0
    const scheduler = createScheduler({
      run: async () => {
        calls++
        throw new Error('boom')
      },
      intervalMinutes: () => 15
    })
    scheduler.start()
    await vi.advanceTimersByTimeAsync(15 * MINUTE)
    expect(calls).toBe(2)
    scheduler.stop()
  })

  it('takes a new interval from the next wait on, when told the settings changed', async () => {
    const scan = fakeScan()
    let interval = 15
    const scheduler = createScheduler({ run: scan.run, intervalMinutes: () => interval })
    scheduler.start()
    await vi.advanceTimersByTimeAsync(MINUTE)

    interval = 5
    scheduler.reschedule()
    await vi.advanceTimersByTimeAsync(5 * MINUTE)
    expect(scan.calls()).toBe(2)
    scheduler.stop()
  })

  it('a manual scan resets the backoff: the user has probably just signed in again', async () => {
    const scan = fakeScan(['auth-expired', 'auth-expired', 'ok'])
    const scheduler = createScheduler({ run: scan.run, intervalMinutes: () => 15 })
    scheduler.start()
    await vi.advanceTimersByTimeAsync(0)

    await scheduler.runNow()
    // The second expired run would double the wait again; a working manual run resets it.
    await scheduler.runNow()
    await vi.advanceTimersByTimeAsync(15 * MINUTE)
    expect(scan.calls()).toBe(4)
    scheduler.stop()
  })

  it('does nothing after stop', async () => {
    const scan = fakeScan()
    const scheduler = createScheduler({ run: scan.run, intervalMinutes: () => 15 })
    scheduler.start()
    await vi.advanceTimersByTimeAsync(0)
    scheduler.stop()
    scheduler.onResume()
    await vi.advanceTimersByTimeAsync(60 * MINUTE)
    expect(scan.calls()).toBe(1)
  })

  it('does not schedule from a scan that finishes after stop', async () => {
    const scan = fakeScan()
    scan.holdNext()
    const scheduler = createScheduler({ run: scan.run, intervalMinutes: () => 15 })
    scheduler.start()
    scheduler.stop()
    scan.finish()
    await vi.advanceTimersByTimeAsync(60 * MINUTE)
    expect(scan.calls()).toBe(1)
  })

  it('can be started again after stop, for a new profile', async () => {
    const scan = fakeScan()
    const scheduler = createScheduler({ run: scan.run, intervalMinutes: () => 15 })
    scheduler.start()
    await vi.advanceTimersByTimeAsync(0)
    scheduler.stop()
    scheduler.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(scan.calls()).toBe(2)
    scheduler.stop()
  })
})
