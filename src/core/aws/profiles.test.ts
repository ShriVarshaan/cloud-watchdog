import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { listProfileNames, parseProfileNames } from './profiles'

const CONFIG = `
# comment
[default]
region = eu-west-1

[profile hackathon]
sso_session = uni
sso_account_id = 111122223333

[profile  spaced name ]
region=us-east-1

[sso-session uni]
sso_start_url = https://example.awsapps.com/start

[services local]
`

const CREDENTIALS = `
[default]
aws_access_key_id = AKIAFAKEFAKEFAKEFAKE
aws_secret_access_key = wJalrFAKEFAKEFAKEFAKE/SECRET

[old-keys]
aws_access_key_id = AKIAFAKEFAKEFAKEFAK2
aws_secret_access_key = anotherFAKEsecret
`

describe('parseProfileNames', () => {
  it('reads profile sections from the config file and ignores other section types', () => {
    expect(parseProfileNames({ config: CONFIG })).toEqual(['default', 'hackathon', 'spaced name'])
  })

  it('reads plain section names from the credentials file', () => {
    expect(parseProfileNames({ credentials: CREDENTIALS })).toEqual(['default', 'old-keys'])
  })

  it('merges both files without duplicates, default first then alphabetical', () => {
    expect(parseProfileNames({ config: CONFIG, credentials: CREDENTIALS })).toEqual([
      'default',
      'hackathon',
      'old-keys',
      'spaced name'
    ])
  })

  it('returns names only, never a key or secret', () => {
    const output = JSON.stringify(parseProfileNames({ config: CONFIG, credentials: CREDENTIALS }))
    expect(output).not.toMatch(/AKIA|SECRET|secret|awsapps/)
  })

  it('handles Windows line endings and empty input', () => {
    expect(parseProfileNames({ config: '[profile a]\r\nregion = x\r\n[profile b]\r\n' })).toEqual(['a', 'b'])
    expect(parseProfileNames({})).toEqual([])
  })
})

describe('listProfileNames', () => {
  const files: Record<string, string> = {
    [join('C:\\Users\\me', '.aws', 'config')]: '[profile from-home]\n',
    [join('C:\\Users\\me', '.aws', 'credentials')]: '[keys-from-home]\n',
    ['D:\\custom\\config']: '[profile from-env]\n'
  }
  const readFile = async (path: string): Promise<string> => {
    const text = files[path]
    if (text === undefined) throw Object.assign(new Error('not found'), { code: 'ENOENT' })
    return text
  }

  it('reads ~/.aws/config and ~/.aws/credentials by default', async () => {
    expect(await listProfileNames({ env: {}, homeDir: 'C:\\Users\\me', readFile })).toEqual([
      'from-home',
      'keys-from-home'
    ])
  })

  it('honours AWS_CONFIG_FILE and AWS_SHARED_CREDENTIALS_FILE like the SDK does', async () => {
    const env = { AWS_CONFIG_FILE: 'D:\\custom\\config', AWS_SHARED_CREDENTIALS_FILE: 'D:\\custom\\missing' }
    expect(await listProfileNames({ env, homeDir: 'C:\\Users\\me', readFile })).toEqual(['from-env'])
  })

  it('returns an empty list when neither file exists', async () => {
    expect(await listProfileNames({ env: {}, homeDir: 'C:\\nobody', readFile })).toEqual([])
  })
})
