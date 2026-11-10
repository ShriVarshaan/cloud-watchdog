// When scans run: once on start, then every N minutes (default 15), and
// straight away when the computer wakes from sleep. The wait is counted from
// the end of a scan, so scans never overlap; asking for a scan while one is
// running joins it.
//
// When the sign-in has expired (for example an SSO session), scanning every
// 15 minutes only produces the same error. The wait then doubles after each
// failed attempt, up to 4 hours, and goes back to normal after the first scan
// that works. A scan the user asks for runs at once regardless.
//
// No Electron imports: index.ts passes powerMonitor's resume event in.

export type ScanOutcome = 'ok' | 'auth-expired' | 'failed' | 'skipped'

export const MAX_BACKOFF_MS = 4 * 60 * 60 * 1000

export interface SchedulerOptions {
  run: () => Promise<ScanOutcome>
  /** Read before every wait, so a changed setting takes effect. */
  intervalMinutes: () => number
}

export interface Scheduler {
  /** Scans now and keeps scanning. */
  start(): void
  stop(): void
  /** Scans now (or joins the scan in progress), then waits a full interval. */
  runNow(): Promise<void>
  /** The computer woke up. */
  onResume(): void
  /** The interval changed: wait the new interval from now. */
  reschedule(): void
}

export function createScheduler(options: SchedulerOptions): Scheduler {
  let timer: ReturnType<typeof setTimeout> | null = null
  let running: Promise<void> | null = null
  let active = false
  /** Consecutive scans that failed because the sign-in expired. */
  let authFailures = 0
  /** Bumped by stop(), so a scan that ends after it does not schedule anything. */
  let generation = 0

  const intervalMs = () => options.intervalMinutes() * 60_000

  function nextDelay(): number {
    if (authFailures === 0) return intervalMs()
    return Math.min(intervalMs() * 2 ** authFailures, Math.max(MAX_BACKOFF_MS, intervalMs()))
  }

  function schedule(): void {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      void runNow()
    }, nextDelay())
  }

  function runNow(): Promise<void> {
    if (!active) return Promise.resolve()
    if (running) return running
    if (timer) {
      clearTimeout(timer)
      timer = null
    }

    const mine = generation
    running = (async () => {
      let outcome: ScanOutcome
      try {
        outcome = await options.run()
      } catch {
        outcome = 'failed'
      }
      // A scan that was running when stop() was called belongs to an earlier
      // session. It must not touch the state of the scan that replaced it.
      if (mine !== generation) return
      if (outcome === 'auth-expired') authFailures++
      else if (outcome === 'ok') authFailures = 0
      running = null
      if (active) schedule()
    })()
    return running
  }

  return {
    start() {
      if (active) return
      active = true
      authFailures = 0
      void runNow()
    },

    stop() {
      active = false
      generation++
      running = null
      if (timer) clearTimeout(timer)
      timer = null
    },

    runNow,

    onResume() {
      void runNow()
    },

    reschedule() {
      if (active && !running) schedule()
    }
  }
}
