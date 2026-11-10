import { describe, expect, it } from 'vitest'
import { isAllowedExternalUrl } from './externalLinks'

describe('isAllowedExternalUrl', () => {
  it.each([
    'https://eu-west-1.console.aws.amazon.com/ec2/home?region=eu-west-1#InstanceDetails:instanceId=i-0abc',
    'https://console.aws.amazon.com/billing/home',
    'https://docs.aws.amazon.com/cli/latest/reference/sso/login.html'
  ])('allows %s', (url) => {
    expect(isAllowedExternalUrl(url)).toBe(true)
  })

  it.each([
    ['plain http', 'http://eu-west-1.console.aws.amazon.com/ec2/home'],
    ['another host', 'https://example.com/'],
    ['a look-alike host', 'https://console.aws.amazon.com.evil.example/'],
    ['a look-alike suffix', 'https://evilconsole.aws.amazon.com/'],
    ['a user name in the URL', 'https://attacker@eu-west-1.console.aws.amazon.com/'],
    ['another port', 'https://console.aws.amazon.com:8443/'],
    ['a file', 'file:///C:/Windows/System32/calc.exe'],
    ['a script', 'javascript:alert(1)'],
    ['not a URL', 'console.aws.amazon.com']
  ])('refuses %s', (_why, url) => {
    expect(isAllowedExternalUrl(url)).toBe(false)
  })
})
