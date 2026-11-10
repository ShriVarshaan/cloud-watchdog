// The only web addresses the app opens in the user's browser: the AWS
// console and the AWS documentation, over HTTPS. Checked in the main process
// right before shell.openExternal, even though main built the URL itself.

const ALLOWED_HOSTS = ['console.aws.amazon.com', 'docs.aws.amazon.com']

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
