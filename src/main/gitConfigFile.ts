import fs from 'fs'
import path from 'path'
import { shq } from '@shared/shellQuote'
import { gitCredentialUrl } from '@shared/gitAccountOps'
import type { GitAccount, GitRepoPick } from '@shared/types'
import { writeWholeBeforeVisible } from './jsonDrops'

export const GITHUB_URL = process.env.KOLOFT_GITHUB_URL || 'https://github.com'

export function credentialUrlOf(a: Pick<GitAccount, 'platform' | 'url'>): string {
  return a.platform === 'github' ? GITHUB_URL : gitCredentialUrl(a.url)
}

export function gitAccountsDir(userData: string): string {
  return path.join(userData, 'git-accounts')
}

function accountConfigPath(dir: string, id: string): string {
  return path.join(dir, 'accounts', `${id.replace(/[^a-z0-9._@+-]/g, '_')}.gitconfig`)
}

function quoted(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

// PLATFORM§46 ADR-0033
export function masterConfigText(picks: GitRepoPick[], dir: string): string {
  return picks
    .flatMap((p) => {
      const include = `\tpath = ${quoted(accountConfigPath(dir, p.account))}\n`
      return [`gitdir:${p.repo}`, `gitdir:${p.repo}/`].map(
        (pattern) => `[includeIf ${quoted(pattern)}]\n${include}`
      )
    })
    .join('')
}

// PLATFORM§46
export function accountConfigText(a: GitAccount, helperPath: string): string {
  return [
    '[koloft]',
    `\taccount = ${quoted(a.id)}`,
    `\tplatform = ${a.platform}`,
    `\thost = ${quoted(a.host)}`,
    `[credential ${quoted(credentialUrlOf(a))}]`,
    '\thelper =',
    `\thelper = ${quoted(`!${shq(helperPath)} ${shq(a.id)}`)}`,
    `\tusername = ${quoted(a.login)}`,
    ...(a.author
      ? [
          '[user]',
          `\tname = ${quoted(a.author.name || a.login)}`,
          `\temail = ${quoted(a.author.email)}`
        ]
      : []),
    ''
  ].join('\n')
}

export function writeGitAccountConfigs(
  dir: string,
  picks: GitRepoPick[],
  accounts: GitAccount[],
  helperPath: string
): string {
  const accountsDir = path.join(dir, 'accounts')
  fs.mkdirSync(accountsDir, { recursive: true })
  const written = new Set<string>()
  for (const a of accounts) {
    const file = accountConfigPath(dir, a.id)
    writeWholeBeforeVisible(file, accountConfigText(a, helperPath))
    written.add(path.basename(file))
  }
  for (const name of fs.readdirSync(accountsDir)) {
    if (!written.has(name)) fs.rmSync(path.join(accountsDir, name), { force: true })
  }
  const master = path.join(dir, 'config')
  writeWholeBeforeVisible(master, masterConfigText(picks, dir))
  return master
}

export function gitConfigEnv(env: NodeJS.ProcessEnv, masterPath: string): NodeJS.ProcessEnv {
  const count = Number(env.GIT_CONFIG_COUNT)
  const n = Number.isInteger(count) && count > 0 ? count : 0
  return {
    ...env,
    [`GIT_CONFIG_KEY_${n}`]: 'include.path',
    [`GIT_CONFIG_VALUE_${n}`]: masterPath,
    GIT_CONFIG_COUNT: String(n + 1)
  }
}
