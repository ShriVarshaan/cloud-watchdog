// Validation for everything the UI sends to the main process. The renderer
// is treated as untrusted: a message is checked against these schemas before
// any handler sees it. Objects are strict, so unknown fields are rejected
// rather than ignored.

import { z } from 'zod'
import type { IpcChannel, IpcInput } from '../shared/ipc'
import { ACTION_KINDS, RESOURCE_KINDS, SCAN_INTERVAL_MINUTES } from '../shared/types'

const noInput = z.undefined()

// AWS allows almost anything in a profile name. Brackets and control
// characters cannot appear in a config section header, so they are refused.
// eslint-disable-next-line no-control-regex
const profileName = z.string().min(1).max(128).regex(/^[^[\]\x00-\x1f\x7f]+$/)

// `${accountId}:${kind}:${region}:${id}`. The key is only ever used to look
// a resource up in the main process's own data.
const resourceKey = z
  .string()
  .max(512)
  .regex(new RegExp(`^\\d{12}:(${RESOURCE_KINDS.join('|')}):[a-z0-9-]{1,32}:\\S+$`))

const ruleSetting = z.strictObject({
  enabled: z.boolean(),
  params: z.record(z.string().min(1).max(64), z.number())
})

// Note what is absent: there is no field that enables actions. That switch
// needs its own native confirmation in the main process (M10).
const settingsUpdate = z.strictObject({
  profile: profileName.nullable().optional(),
  scanIntervalMinutes: z.number().int().min(SCAN_INTERVAL_MINUTES.min).max(SCAN_INTERVAL_MINUTES.max).optional(),
  notificationsEnabled: z.boolean().optional(),
  startAtLogin: z.boolean().optional(),
  rules: z.record(z.string().min(1).max(64), ruleSetting).optional()
})

export const ipcSchemas = {
  'app:getState': noInput,
  'profiles:list': noInput,
  'profiles:select': z.strictObject({ profile: profileName }),
  'scan:run': noInput,
  'scan:getLatest': noInput,
  'flags:dismiss': z.strictObject({
    flagId: z.string().min(1).max(200),
    hours: z.number().int().min(1).max(8760).optional()
  }),
  'settings:update': settingsUpdate,
  'resource:manualSteps': z.strictObject({ resourceKey }),
  'resource:openConsole': z.strictObject({ resourceKey }),
  'actions:preview': z.strictObject({ resourceKey, action: z.enum(ACTION_KINDS) }),
  'actions:execute': z.strictObject({ token: z.string().min(16).max(200) })
  // Fails to compile if a channel is missing or a schema's result does not
  // match the input type declared in src/shared/ipc.ts.
} satisfies { [C in IpcChannel]: z.ZodType<IpcInput<C>> }
