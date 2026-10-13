import { createHash } from 'crypto'
import fs from 'fs'
import path from 'path'
import { shq } from '@shared/shellQuote'
import { gitCredentialUrl } from '@shared/gitAccountOps'
import type { GitAccount, GitRepoPick } from '@shared/types'
import type { GitTarget } from './gitPlatformApi'
import type { RewriteRule } from './gitSshRemotes'
import { writeWholeBeforeVisible } from './jsonDrops'

const PICK_FILE_NAME_LENGTH = 16

export const GITHUB_URL = process.env.KOLOFT_GITHUB_URL || 'https://github.com'

export function credentialUrlOf(a: Pick<GitAccount, 'platform' | 'url'>): string {
  return a.platform === 'github' ? GITHUB_URL : gitCredentialUrl(a.url)
}

export function apiTargetOf(a: Pick<GitAccount, 'platform' | 'url'>): GitTarget {
  return { platform: a.platform, url: a.platform === 'github' ? GITHUB_URL : a.url }
}

const CONFIG_ENTRY_VARIABLE = /^GIT_CONFIG_(COUNT|KEY_\d+|VALUE_\d+)$/

export function withoutConfigEntries(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(env)) if (!CONFIG_ENTRY_VARIABLE.test(k)) out[k] = v
  return out
}

export function gitAccountsDir(userData: string): string {
  return path.join(userData, 'git-accounts')
}

function fileNameOf(id: string): string {
  return id.replace(/[^a-z0-9._@+-]/g, '_')
}

function accountConfigPath(dir: string, id: string): string {
  return path.join(dir, 'accounts', `${fileNameOf(id)}.gitconfig`)
}

function pickConfigPath(dir: string, repo: string): string {
  const name = createHash('sha256').update(repo).digest('hex').slice(0, PICK_FILE_NAME_LENGTH)
  return path.join(dir, 'picks', `${name}.gitconfig`)
}

export function sshKeyPath(dir: string, id: string): string {
  return path.join(dir, 'ssh', fileNameOf(id))
}

function quoted(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

// PLATFORM§46 ADR-0033
export function masterConfigText(picks: GitRepoPick[], dir: string): string {
  return picks
    .flatMap((p) => {
      const include = [accountConfigPath(dir, p.account), pickConfigPath(dir, p.repo)]
        .map((file) => `\tpath = ${quoted(file)}\n`)
        .join('')
      return [`gitdir:${p.repo}`, `gitdir:${p.repo}/`].map(
        (pattern) => `[includeIf ${quoted(pattern)}]\n${include}`
      )
    })
    .join('')
}

// PLATFORM§53 ADR-0035
export function rewriteConfigText(rules: RewriteRule[]): string {
  return rules.map(([to, from]) => `[url ${quoted(to)}]\n\tinsteadOf = ${quoted(from)}\n`).join('')
}

// PLATFORM§53 ADR-0035
export function sshKeyConfigText(key: string): string {
  return `[core]\n\tsshCommand = ${quoted(`ssh -i ${shq(key)} -o IdentitiesOnly=yes`)}\n`
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

function keepOnly(folder: string, kept: Set<string>): void {
  for (const name of fs.readdirSync(folder)) {
    if (!kept.has(name)) fs.rmSync(path.join(folder, name), { force: true })
  }
}

export function writeGitAccountConfigs(
  dir: string,
  picks: GitRepoPick[],
  accounts: GitAccount[],
  helperPath: string,
  pickTexts: Map<string, string>
): string {
  const accountsDir = path.join(dir, 'accounts')
  const picksDir = path.join(dir, 'picks')
  for (const d of [accountsDir, picksDir]) fs.mkdirSync(d, { recursive: true })
  const written = new Set<string>()
  for (const a of accounts) {
    const file = accountConfigPath(dir, a.id)
    writeWholeBeforeVisible(file, accountConfigText(a, helperPath))
    written.add(path.basename(file))
  }
  keepOnly(accountsDir, written)
  const picked = new Set<string>()
  for (const p of picks) {
    const file = pickConfigPath(dir, p.repo)
    const text = pickTexts.get(p.repo)
    if (text !== undefined) writeWholeBeforeVisible(file, text)
    picked.add(path.basename(file))
  }
  keepOnly(picksDir, picked)
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
