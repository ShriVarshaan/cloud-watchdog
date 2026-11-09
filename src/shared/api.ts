// The API the preload script exposes to the renderer as `window.watchdog`.
// This is the only way the UI can talk to the main process. It grows in M2
// with the typed IPC contract; in M1 it only proves the bridge works.

export interface WatchdogApi {
  readonly apiVersion: 1
}
