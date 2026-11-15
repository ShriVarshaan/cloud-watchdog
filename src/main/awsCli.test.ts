import { describe, expect, it } from 'vitest'
import { detectAwsCli } from './awsCli'

const ENV = { ProgramFiles: 'C:\\Program Files', LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' }

/** A runner that answers for the given executables and fails like a missing file for the rest. */
function runner(answers: Record<string, string>) {
  const calls: string[] = []
  const run = async (file: string, args: string[]) => {
    calls.push(`${file} ${args.join(' ')}`)
    const output = answers[file]
    if (output === undefined) throw Object.assign(new Error(`spawn ${file} ENOENT`), { code: 'ENOENT' })
    return output
  }
  return { run, calls }
}

describe('detectAwsCli', () => {
  it('finds the CLI on the PATH and reads its version', async () => {
    const { run, calls } = runner({ aws: 'aws-cli/2.17.3 Python/3.11.9 Windows/10 exe/AMD64\r\n' })
    expect(await detectAwsCli({ run, env: ENV })).toEqual({ installed: true, version: '2.17.3' })
    expect(calls).toEqual(['aws --version'])
  })

  it('finds a CLI installed after the app started, in the folder its installer uses', async () => {
    // The app keeps the PATH it started with, so a fresh install is not on it yet.
    const { run } = runner({ 'C:\\Program Files\\Amazon\\AWSCLIV2\\aws.exe': 'aws-cli/2.17.3 Python/3.11.9 Windows/10 exe/AMD64' })
    expect(await detectAwsCli({ run, env: ENV })).toEqual({ installed: true, version: '2.17.3' })
  })

  it('finds a CLI installed for this user only', async () => {
    const { run } = runner({ 'C:\\Users\\me\\AppData\\Local\\Programs\\Amazon\\AWSCLIV2\\aws.exe': 'aws-cli/2.9.0 Python/3.9.11' })
    expect(await detectAwsCli({ run, env: ENV })).toEqual({ installed: true, version: '2.9.0' })
  })

  it('reads the version of the older CLI version 1', async () => {
    const { run } = runner({ aws: 'aws-cli/1.33.0 Python/3.12.0 Windows/11 botocore/1.35.0' })
    expect(await detectAwsCli({ run, env: ENV })).toEqual({ installed: true, version: '1.33.0' })
  })

  it('says not installed when nothing answers', async () => {
    const { run, calls } = runner({})
    expect(await detectAwsCli({ run, env: ENV })).toEqual({ installed: false, version: null })
    expect(calls).toHaveLength(3)
  })

  it('does not count a program called aws that is not the AWS CLI', async () => {
    const { run } = runner({ aws: 'something else entirely' })
    expect(await detectAwsCli({ run, env: ENV })).toEqual({ installed: false, version: null })
  })

  it('skips the install folders it cannot work out', async () => {
    const { run, calls } = runner({})
    await detectAwsCli({ run, env: {} })
    expect(calls).toEqual(['aws --version'])
  })
})
