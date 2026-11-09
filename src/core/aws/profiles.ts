// Lists the names of the AWS profiles on this machine, so the user can pick
// one. Only the `[section]` header lines are looked at. Keys, secrets and
// SSO URLs on the other lines are never parsed, kept or returned.

import { readFile as fsReadFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

const SECTION = /^\s*\[([^\]]+)\]/

function sectionNames(text: string): string[] {
  const names: string[] = []
  for (const line of text.split(/\r?\n/)) {
    const name = SECTION.exec(line)?.[1]?.trim()
    if (name) names.push(name)
  }
  return names
}

export function parseProfileNames(files: { config?: string; credentials?: string }): string[] {
  const names = new Set<string>()

  // ~/.aws/config: "[default]" and "[profile name]". Other section types
  // ("[sso-session x]", "[services x]") are not profiles.
  for (const section of sectionNames(files.config ?? '')) {
    if (section === 'default') names.add(section)
    const profile = /^profile\s+(.+)$/.exec(section)?.[1]?.trim()
    if (profile) names.add(profile)
  }
  // ~/.aws/credentials: every section is a profile.
  for (const section of sectionNames(files.credentials ?? '')) names.add(section)

  return [...names].sort((a, b) => (a === 'default' ? -1 : b === 'default' ? 1 : a.localeCompare(b)))
}

export interface ProfileSources {
  env?: Record<string, string | undefined>
  homeDir?: string
  readFile?: (path: string) => Promise<string>
}

/** Reads the same two files the AWS CLI and SDK use, including the env overrides. */
export async function listProfileNames(sources: ProfileSources = {}): Promise<string[]> {
  const env = sources.env ?? process.env
  const home = sources.homeDir ?? homedir()
  const read = sources.readFile ?? ((path: string) => fsReadFile(path, 'utf8'))
  // A missing or unreadable file just means no profiles from that file.
  const readOrEmpty = (path: string) => read(path).catch(() => '')

  const [config, credentials] = await Promise.all([
    readOrEmpty(env['AWS_CONFIG_FILE'] || join(home, '.aws', 'config')),
    readOrEmpty(env['AWS_SHARED_CREDENTIALS_FILE'] || join(home, '.aws', 'credentials'))
  ])
  return parseProfileNames({ config, credentials })
}
