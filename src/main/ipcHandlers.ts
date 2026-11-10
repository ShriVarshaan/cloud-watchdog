// Registers one handler per channel in the IPC contract. Every message goes
// through the same three gates, in this order:
//
//   1. sender check   - did it come from the app's own window?
//   2. validation     - does the input match the zod schema for the channel?
//   3. handler        - typed code that never sees unvalidated input
//
// Nothing is thrown back to the renderer. Failures are returned as data, and
// unexpected errors are reduced to a generic message so file paths or SQL
// never reach the UI.
//
// This file imports only types from Electron, so it is unit-tested in plain Node.

import type { IpcMainInvokeEvent } from 'electron'
import {
  IPC_CHANNELS,
  type IpcChannel,
  type IpcErrorCode,
  type IpcInput,
  type IpcOutput,
  type IpcResult
} from '../shared/ipc'
import { ipcSchemas } from './ipcSchemas'

export type IpcHandler<C extends IpcChannel> = (input: IpcInput<C>) => Promise<IpcResult<IpcOutput<C>>>
export type IpcHandlers = { [C in IpcChannel]: IpcHandler<C> }

/** The part of Electron's `ipcMain` this file uses. */
export interface IpcMainLike {
  handle(channel: string, listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>): void
}

export interface IpcOptions {
  isTrustedSender(event: IpcMainInvokeEvent): boolean
  handlers: IpcHandlers
  /** Called with errors a handler threw. They are logged in main, never sent to the UI. */
  onError?(channel: IpcChannel, error: unknown): void
}

export function ok<T>(value: T): IpcResult<T> {
  return { ok: true, value }
}

export function fail(code: IpcErrorCode, message: string): IpcResult<never> {
  return { ok: false, error: { code, message } }
}

/** Names the fields that failed, without repeating the rejected values. */
function invalidInputMessage(paths: ReadonlyArray<ReadonlyArray<PropertyKey>>): string {
  const fields = new Set<string>()
  for (const path of paths) {
    const field = path[0]
    if (typeof field === 'string' && /^[A-Za-z]{1,32}$/.test(field)) fields.add(field)
  }
  return fields.size > 0 ? `Invalid input: ${[...fields].join(', ')}.` : 'Invalid input.'
}

export function registerIpcHandlers(ipc: IpcMainLike, options: IpcOptions): void {
  for (const channel of IPC_CHANNELS) {
    // The contract types tie each channel to its own input and output, but
    // TypeScript cannot follow that through a loop, so inside the loop the
    // handler is treated as taking validated-but-untyped input.
    const handler = options.handlers[channel] as (input: unknown) => Promise<IpcResult<unknown>>
    const schema = ipcSchemas[channel]

    ipc.handle(channel, async (event, ...args): Promise<IpcResult<unknown>> => {
      if (!options.isTrustedSender(event)) {
        return fail('forbidden', 'This request did not come from the Cloud Watchdog window.')
      }
      if (args.length > 1) return fail('invalid-input', 'Invalid input.')

      const parsed = schema.safeParse(args[0])
      if (!parsed.success) {
        return fail('invalid-input', invalidInputMessage(parsed.error.issues.map((issue) => issue.path)))
      }

      try {
        return await handler(parsed.data)
      } catch (error) {
        options.onError?.(channel, error)
        return fail('internal', 'Something went wrong inside Cloud Watchdog.')
      }
    })
  }
}
