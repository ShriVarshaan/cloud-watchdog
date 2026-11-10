// React hooks over window.watchdog, the preload bridge. The UI's only link
// to the main process: every call returns a result envelope, never throws.

import { useEffect, useState } from 'react'
import type { IpcResult } from '../shared/ipc'
import type { AppState, ScanProgress, ScanResult } from '../shared/types'

export const api = () => window.watchdog

/** The value, or throws with the error message: for callers that show it. */
export function unwrap<T>(result: IpcResult<T>): T {
  if (!result.ok) throw new Error(result.error.message)
  return result.value
}

/** App state, kept current by state:changed events. null until the first answer. */
export function useAppState(): { state: AppState | null; error: string | null } {
  const [state, setState] = useState<AppState | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    const off = api().onStateChanged((next) => setState(next))
    void api()
      .getState()
      .then((result) => {
        if (!live) return
        if (result.ok) setState((current) => current ?? result.value)
        else setError(result.error.message)
      })
    return () => {
      live = false
      off()
    }
  }, [])

  return { state, error }
}

/**
 * The full latest result. Fetched again when a new scan finishes or the
 * number of open flags changes (a flag was dismissed).
 */
export function useLatestScan(state: AppState | null): ScanResult | null {
  const [latest, setLatest] = useState<ScanResult | null>(null)
  const scanId = state?.lastScan?.scanId ?? null
  const openFlags = state?.lastScan?.openFlagCount ?? null

  useEffect(() => {
    if (scanId === null) return
    let live = true
    void api()
      .getLatestScan()
      .then((result) => {
        if (live && result.ok) setLatest(result.value)
      })
    return () => {
      live = false
    }
  }, [scanId, openFlags])

  return scanId === null ? null : latest
}

/** Progress of the scan in progress, or null. */
export function useScanProgress(scanInProgress: boolean): ScanProgress | null {
  const [progress, setProgress] = useState<ScanProgress | null>(null)
  useEffect(() => api().onScanProgress(setProgress), [])
  return scanInProgress ? progress : null
}

/** The current time, updated every 30 seconds, for "2 minutes ago". */
export function useNow(intervalMs = 30_000): Date {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), intervalMs)
    return () => clearInterval(timer)
  }, [intervalMs])
  return now
}
