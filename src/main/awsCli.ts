// Whether the AWS CLI is installed, for the setup steps on the welcome
// screen. Runs `aws --version` and nothing else: a fixed program and fixed
// arguments, no shell, and only the version number is kept from the output.
//
// The app keeps the PATH it was started with, so a CLI installed while the
// app is open is not on it. The folders the CLI's Windows installer uses are
// tried too, so "Check Again" finds a fresh install without a restart.

import { execFile } from 'node:child_process'
import { win32 } from 'node:path'
import type { AwsCliStatus } from '../shared/types'

export interface AwsCliDeps {
  /** Runs a program and resolves to what it printed. Rejects if it cannot be started or fails. */
  run(file: string, args: string[]): Promise<string>
  env: Record<string, string | undefined>
}

// "aws-cli/2.17.3 Python/3.11.9 Windows/10 exe/AMD64"
const VERSION = /\baws-cli\/(\d+\.\d+\.\d+)\b/

function candidates(env: AwsCliDeps['env']): string[] {
  const files = ['aws']
  // All users (the default), then just this user.
  if (env['ProgramFiles']) files.push(win32.join(env['ProgramFiles'], 'Amazon', 'AWSCLIV2', 'aws.exe'))
  if (env['LOCALAPPDATA']) files.push(win32.join(env['LOCALAPPDATA'], 'Programs', 'Amazon', 'AWSCLIV2', 'aws.exe'))
  return files
}

export async function detectAwsCli(deps: AwsCliDeps): Promise<AwsCliStatus> {
  for (const file of candidates(deps.env)) {
    try {
      const version = VERSION.exec(await deps.run(file, ['--version']))?.[1]
      if (version) return { installed: true, version }
    } catch {
      // Not there, or not runnable: try the next place.
    }
  }
  return { installed: false, version: null }
}

/** The real runner. Version 1 of the CLI printed its version to stderr, so both are read. */
export function runProgram(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 10_000, windowsHide: true, shell: false }, (error, stdout, stderr) => {
      if (error) reject(error)
      else resolve(`${stdout}\n${stderr}`)
    })
  })
}
