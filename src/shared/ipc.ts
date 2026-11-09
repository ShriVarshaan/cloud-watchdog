// The IPC contract: every message the UI can send to the main process, and
// the two events the main process sends back. This file is the single source
// of truth for three things:
//
//   - src/preload/index.ts builds `window.watchdog` by looping over API_METHODS
//   - src/main/ipcHandlers.ts registers exactly one handler per channel
//   - src/main/ipcSchemas.ts must provide a zod schema for every channel's input
//
// TypeScript fails the build if any of the three drifts from this file.
// There is deliberately no generic "call AWS" or "run SQL" channel, and the
// UI refers to resources only by key; the main process looks the key up in
// its own data.

import type {
  ActionKind,
  ActionPreview,
  ActionResult,
  AppState,
  Identity,
  ManualSteps,
  ScanErrorCode,
  ScanProgress,
  ScanResult,
  Settings
} from './types'

// ---------------------------------------------------------------------------
// Result envelope
// ---------------------------------------------------------------------------

/**
 * `forbidden`: the message did not come from the app's own window.
 * `invalid-input`: the input failed validation in the main process.
 * The ScanErrorCode values are used when a call to AWS failed (profiles:select).
 */
export type IpcErrorCode =
  | 'forbidden'
  | 'invalid-input'
  | 'not-found'
  | 'not-implemented'
  | 'internal'
  | ScanErrorCode

export interface IpcError {
  code: IpcErrorCode
  message: string
}

/**
 * Every call resolves to this instead of throwing. Errors thrown across
 * Electron IPC lose their type and most of their fields, so failures are
 * returned as data.
 */
export type IpcResult<T> = { ok: true; value: T } | { ok: false; error: IpcError }

// ---------------------------------------------------------------------------
// Renderer -> main (ipcRenderer.invoke)
// ---------------------------------------------------------------------------

/** `input: undefined` means the call takes no argument. */
export interface IpcContract {
  'app:getState': { input: undefined; output: AppState }
  /** Profile names only. Keys and secrets never cross this boundary. */
  'profiles:list': { input: undefined; output: string[] }
  'profiles:select': { input: { profile: string }; output: Identity }
  /** Starts a scan, or joins the one already running. Returns its id. */
  'scan:run': { input: undefined; output: { scanId: string } }
  'scan:getLatest': { input: undefined; output: ScanResult | null }
  /** Without `hours` the flag stays hidden until it resolves. */
  'flags:dismiss': { input: { flagId: string; hours?: number | undefined }; output: null }
  'settings:update': { input: SettingsUpdate; output: Settings }
  'resource:manualSteps': { input: { resourceKey: string }; output: ManualSteps }
  /** The main process builds the URL. The UI never supplies one. */
  'resource:openConsole': { input: { resourceKey: string }; output: null }
  'actions:preview': { input: { resourceKey: string; action: ActionKind }; output: ActionPreview }
  'actions:execute': { input: { token: string }; output: ActionResult }
}

export type SettingsUpdate = { [K in keyof Settings]?: Settings[K] | undefined }

export type IpcChannel = keyof IpcContract
export type IpcInput<C extends IpcChannel> = IpcContract[C]['input']
export type IpcOutput<C extends IpcChannel> = IpcContract[C]['output']

/** Method name on `window.watchdog` -> channel. */
export const API_METHODS = {
  getState: 'app:getState',
  listProfiles: 'profiles:list',
  selectProfile: 'profiles:select',
  runScan: 'scan:run',
  getLatestScan: 'scan:getLatest',
  dismissFlag: 'flags:dismiss',
  updateSettings: 'settings:update',
  getManualSteps: 'resource:manualSteps',
  openConsole: 'resource:openConsole',
  previewAction: 'actions:preview',
  executeAction: 'actions:execute'
} as const satisfies Record<string, IpcChannel>

type ApiMethods = typeof API_METHODS

// Compile-time check that API_METHODS covers every channel in the contract.
type MissingChannels = Exclude<IpcChannel, ApiMethods[keyof ApiMethods]>
const _everyChannelHasAMethod: MissingChannels extends never ? true : never = true
void _everyChannelHasAMethod

export const IPC_CHANNELS = Object.values(API_METHODS) as readonly IpcChannel[]

// ---------------------------------------------------------------------------
// Main -> renderer (webContents.send)
// ---------------------------------------------------------------------------

export interface IpcEvents {
  'scan:progress': ScanProgress
  'state:changed': AppState
}

export type IpcEventChannel = keyof IpcEvents

/** Subscribe method name on `window.watchdog` -> event channel. */
export const API_EVENTS = {
  onScanProgress: 'scan:progress',
  onStateChanged: 'state:changed'
} as const satisfies Record<string, IpcEventChannel>

type ApiEvents = typeof API_EVENTS

// ---------------------------------------------------------------------------
// window.watchdog
// ---------------------------------------------------------------------------

type InvokeMethod<C extends IpcChannel> =
  IpcInput<C> extends undefined ? () => Promise<IpcResult<IpcOutput<C>>> : (input: IpcInput<C>) => Promise<IpcResult<IpcOutput<C>>>

/** Call to stop listening. */
export type Unsubscribe = () => void

/** The API the preload script exposes to the renderer as `window.watchdog`. */
export type WatchdogApi = { readonly apiVersion: 1 } & {
  readonly [M in keyof ApiMethods]: InvokeMethod<ApiMethods[M]>
} & {
  readonly [E in keyof ApiEvents]: (listener: (payload: IpcEvents[ApiEvents[E]]) => void) => Unsubscribe
}
