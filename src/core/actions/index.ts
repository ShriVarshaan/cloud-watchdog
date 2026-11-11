// The complete list of things the app can change in an AWS account.

import type { ActionDriver } from './guard'
import { stopEc2 } from './stopEc2'
import { stopRds } from './stopRds'

export const ACTION_DRIVERS: readonly ActionDriver[] = [stopEc2, stopRds]
