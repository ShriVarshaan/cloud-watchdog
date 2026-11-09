// Who the selected profile signs in as. Shown to the user before the first
// scan, and re-checked before any action, so the app never works on an
// account the user did not expect. sts:GetCallerIdentity needs no IAM
// permission.

import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts'
import type { Identity } from '../../shared/types'
import { HOME_REGION, type ClientFactory } from './clients'

export async function getIdentity(clients: ClientFactory, signal?: AbortSignal): Promise<Identity> {
  const response = await clients
    .get(STSClient, HOME_REGION)
    .send(new GetCallerIdentityCommand({}), signal ? { abortSignal: signal } : {})

  if (!response.Account || !response.Arn) {
    throw new Error('AWS did not return an account id for this profile.')
  }
  return { accountId: response.Account, arn: response.Arn, profile: clients.profile }
}
