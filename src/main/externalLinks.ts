// The only web addresses the app opens in the user's browser: the AWS
// console and the AWS documentation, over HTTPS. Checked in the main process
// right before shell.openExternal, even though main built the URL itself.

import type { SetupGuide } from '../shared/types'

const ALLOWED_HOSTS = ['console.aws.amazon.com', 'docs.aws.amazon.com']

/** The AWS CLI guides behind the setup steps on the welcome screen. */
export const SETUP_GUIDE_URLS: Record<SetupGuide, string> = {
  'install-cli': 'https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html',
  'access-keys': 'https://docs.aws.amazon.com/cli/latest/userguide/cli-authentication-user.html',
  sso: 'https://docs.aws.amazon.com/cli/latest/userguide/cli-configure-sso.html'
}

export function isAllowedExternalUrl(text: string): boolean {
  let url: URL
  try {
    url = new URL(text)
  } catch {
    return false
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return false
  const host = url.hostname.toLowerCase()
  // An exact host, or a subdomain of the console such as eu-west-1.console.aws.amazon.com.
  return ALLOWED_HOSTS.includes(host) || host.endsWith('.console.aws.amazon.com')
}
