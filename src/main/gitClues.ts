import type { GitAccount } from '@shared/types'

const FIXED_GIT_USERNAMES = new Set(['git', 'oauth2', 'x-access-token'])
const TOKEN_PREFIX = /^(gh[pousr]_|github_pat_)/
const TOKEN_LIKE = /^[A-Za-z0-9_-]{36,}$/
const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/

export function plausibleLogin(name: string): string | null {
  if (FIXED_GIT_USERNAMES.has(name.toLowerCase())) return null
  if (TOKEN_PREFIX.test(name) || TOKEN_LIKE.test(name)) return null
  return GITHUB_LOGIN.test(name) ? name : null
}

export function loginFromRemoteUrl(url: string): string | null | 'discard' {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null
  if (parsed.password) return 'discard'
  return parsed.username ? plausibleLogin(decodeURIComponent(parsed.username)) : null
}

const FILL_ASKED_PASSWORD_FOR = /could not read Password for '[a-z]+:\/\/([^@'/]+)@/

export function loginFromCredentialFill(output: string): string | null {
  const m = FILL_ASKED_PASSWORD_FOR.exec(output)
  return m ? plausibleLogin(decodeURIComponent(m[1])) : null
}

const yamlScalar = (s: string): string => s.trim().replace(/^(['"])(.*)\1$/, '$2')
const indentOf = (line: string): number => line.length - line.trimStart().length

// PLATFORM§47
export function githubHostEntry(hostsYml: string): { user?: string; token?: string } {
  const lines = hostsYml.split('\n')
  const start = lines.findIndex((l) => /^["']?github\.com["']?:\s*$/.test(l))
  if (start < 0) return {}
  const block: string[] = []
  for (const l of lines.slice(start + 1)) {
    if (l.trim() && indentOf(l) === 0) break
    if (l.trim()) block.push(l)
  }
  if (!block.length) return {}
  const top = indentOf(block[0])
  let user: string | undefined
  let topToken: string | undefined
  const userTokens = new Map<string, string>()
  let inUsers = false
  let current: string | undefined
  for (const l of block) {
    const m = /^([^:]+):\s*(.*)$/.exec(l.trim())
    if (!m) continue
    const [, key, value] = m
    if (indentOf(l) === top) {
      inUsers = key === 'users'
      current = undefined
      if (key === 'user') user = yamlScalar(value)
      if (key === 'oauth_token') topToken = yamlScalar(value)
    } else if (inUsers && !value.trim()) current = yamlScalar(key)
    else if (inUsers && current && key === 'oauth_token') userTokens.set(current, yamlScalar(value))
  }
  const token = (user && userTokens.get(user)) || topToken
  return { ...(user ? { user } : {}), ...(token ? { token } : {}) }
}

export function ghActiveLogin(
  hostsYml: string,
  hasGhHelper: boolean,
  remoteIsHttps: boolean
): string | null {
  if (!hasGhHelper || !remoteIsHttps) return null
  const { user } = githubHostEntry(hostsYml)
  return user ? plausibleLogin(user) : null
}

const GH_CREDENTIAL_HELPER = /(^|[\s/'"!])gh(\.exe)?['"]?\s+auth\s+git-credential\b/

export function usesGhCredentialHelper(helperConfigLines: string): boolean {
  return helperConfigLines
    .split('\n')
    .some(
      (l) =>
        /^credential\.(https:\/\/github\.com\/?\.)?helper\s/.test(l) && GH_CREDENTIAL_HELPER.test(l)
    )
}

const SSH_GREETING = /^Hi ([^!\s]+)!/m

// PLATFORM§48
export function loginFromSshGreeting(stderr: string): string | null {
  const m = SSH_GREETING.exec(stderr)
  return m ? plausibleLogin(m[1]) : null
}

const NOREPLY = /^(?:(\d+)\+)?([^@+]+)@users\.noreply\.github\.com$/i

export function loginFromCommitEmails(emails: string[], accounts: GitAccount[]): string | null {
  const found = new Set<string>()
  for (const email of emails) {
    const m = NOREPLY.exec(email.trim())
    if (!m) continue
    const id = m[1] ? Number(m[1]) : undefined
    const account = accounts.find(
      (a) => a.login.toLowerCase() === m[2].toLowerCase() && (id === undefined || a.id === id)
    )
    if (account) found.add(account.login)
  }
  return found.size === 1 ? [...found][0] : null
}

const ASKING_AGENTS = /1password|secretive|gpg-agent/i

export function sshSetting(sshG: string, key: string): string | undefined {
  for (const line of sshG.split('\n')) {
    const m = /^(\S+)\s+(.*)$/.exec(line.trim())
    if (m && m[1].toLowerCase() === key) return m[2]
  }
  return undefined
}

// PLATFORM§48
export function sshClueSkipped(sshG: string, env: NodeJS.ProcessEnv): boolean {
  if (env.GIT_SSH_COMMAND || env.GIT_SSH) return true
  const proxy = sshSetting(sshG, 'proxycommand')
  if (proxy && proxy !== 'none') return true
  const agent = sshSetting(sshG, 'identityagent')
  const agentSocket = agent && agent !== 'SSH_AUTH_SOCK' ? agent : env.SSH_AUTH_SOCK
  return !!agentSocket && ASKING_AGENTS.test(agentSocket)
}

// PLATFORM§48
export const SSH_SAFE_OPTIONS: readonly string[] = [
  '-T',
  '-o',
  'BatchMode=yes',
  '-o',
  'StrictHostKeyChecking=yes',
  '-o',
  'UpdateHostKeys=no',
  '-o',
  'CheckHostIP=no',
  '-o',
  'ControlMaster=no',
  '-o',
  'ClearAllForwardings=yes',
  '-o',
  'AddKeysToAgent=no',
  '-o',
  'ConnectTimeout=5',
  '-o',
  'LogLevel=ERROR',
  '-a',
  '-x'
]
