// What part of the last scan failed, and what to do about it.

import { KIND_EXPLANATIONS } from '../../shared/explain'
import { RESOURCE_KINDS, type ResourceKind, type ScanError, type ScanErrorCode } from '../../shared/types'

const WHAT: Record<string, string> = {
  regions: 'The list of regions',
  freetier: 'The account plan and free tier',
  pricing: 'Prices',
  cloudwatch: 'CPU readings for the idle check'
}

const FIX: Record<ScanErrorCode, string> = {
  'access-denied':
    "The profile is not allowed to make this call. Add the permissions in iam/cloud-watchdog-readonly.json to the profile's IAM user or role.",
  throttled: 'AWS asked the app to slow down. The next scan tries again.',
  'region-disabled': 'This region is not switched on for the account, so there is nothing in it.',
  'auth-expired': 'The sign-in has expired. Sign in again, for example with aws sso login.',
  network: 'AWS could not be reached. Check the internet connection; the next scan tries again.',
  unknown: 'Something unexpected went wrong. The next scan tries again.'
}

function what(error: ScanError): string {
  const name = (RESOURCE_KINDS as readonly string[]).includes(error.scanner)
    ? `${KIND_EXPLANATIONS[error.scanner as ResourceKind].name}s`
    : (WHAT[error.scanner] ?? error.scanner)
  return error.region ? `${name} in ${error.region}` : name
}

export function ScanErrors({ errors }: { errors: readonly ScanError[] }) {
  if (errors.length === 0) {
    return <p className="empty">Every part of the last scan worked.</p>
  }
  return (
    <section className="scan-errors" aria-label="Scan problems">
      <p className="quiet">Resources in these places may be missing or show data from an earlier scan.</p>
      <ul className="group error-list">
        {errors.map((error, index) => (
          <li key={`${error.scanner}|${error.region}|${index}`} className="group-row group-row-stacked">
            <p className="error-what">{what(error)}</p>
            <p>{FIX[error.code]}</p>
            <p className="group-note">AWS said: {error.message}</p>
          </li>
        ))}
      </ul>
    </section>
  )
}
