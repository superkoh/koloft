import type { GitAccount } from '@shared/types'
import { credentialUrlOf } from './gitConfigFile'

const SCP_LIKE = /^(?:([^@/]+)@)?([^:/]+):(?!\/)(.*)$/
export const AZURE_SSH_HOST = 'ssh.dev.azure.com'
export const AZURE_HOST = 'dev.azure.com'
const AZURE_SSH_PATH = /^v3\/([^/]+)\/([^/]+)\/([^/]+)$/
const REMOTE_URL_LINE = /^remote\..+\.(?:push)?url\s+(.+)$/

// PLATFORM§52
const SSH_ONLY_ANSWER =
  /^remote: (?:Git access over HTTP is not allowed|Interacting with repositories by HTTP protocol is not allowed)\s*$/m
const SERVER_FORBADE = /The requested URL returned error: 403\b/

export type HttpsTurnedAway = 'ssh-only' | 'forbidden'

// PLATFORM§52
export function httpsTurnedAway(stderr: string): HttpsTurnedAway | null {
  if (SSH_ONLY_ANSWER.test(stderr)) return 'ssh-only'
  return SERVER_FORBADE.test(stderr) ? 'forbidden' : null
}

export interface SshTarget {
  dest: string
  port?: string
  path: string
  prefix: string
}

export function trimRepoPath(p: string): string {
  return p
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .replace(/\.git$/, '')
}

export function azureSshPath(p: string): string {
  const m = AZURE_SSH_PATH.exec(p)
  return m ? `${m[1]}/${m[2]}/_git/${m[3]}` : p
}

export function sshTarget(url: string): SshTarget | null {
  if (url.startsWith('ssh://')) {
    try {
      const u = new URL(url)
      const user = u.username ? `${decodeURIComponent(u.username)}@` : ''
      const port = u.port ? `:${u.port}` : ''
      return {
        dest: `${user}${u.hostname}`,
        ...(u.port ? { port: u.port } : {}),
        path: u.pathname.replace(/^\/+/, ''),
        prefix: `ssh://${user}${u.hostname}${port}/`
      }
    } catch {
      return null
    }
  }
  const m = SCP_LIKE.exec(url)
  if (!m) return null
  const dest = m[1] ? `${m[1]}@${m[2]}` : m[2]
  return { dest, path: m[3], prefix: `${dest}:` }
}

export function remoteUrlsOf(configLines: string): string[] {
  const urls = configLines
    .split('\n')
    .map((l) => REMOTE_URL_LINE.exec(l.trim())?.[1])
    .filter((u): u is string => !!u)
  return [...new Set(urls)]
}

function sshHostOf(a: Pick<GitAccount, 'platform' | 'url'>): string {
  return a.platform === 'azure' ? AZURE_SSH_HOST : new URL(credentialUrlOf(a)).hostname
}

export type RewriteRule = [https: string, sshOrHttps: string]

export interface RepoRemotes {
  rules: RewriteRule[]
  ssh?: { url: string; dest: string; port?: string }
}

function httpsBase(a: Pick<GitAccount, 'platform' | 'url'>): string {
  return `${a.platform === 'github' ? credentialUrlOf(a) : a.url}/`
}

function httpsOf(
  a: Pick<GitAccount, 'platform' | 'url'>,
  t: SshTarget
): { url: string; rule: RewriteRule } | null {
  if (a.platform !== 'azure')
    return { url: `${httpsBase(a)}${t.path}`, rule: [httpsBase(a), t.prefix] }
  const m = AZURE_SSH_PATH.exec(t.path.replace(/\/+$/, ''))
  const azure = new URL(a.url)
  if (!m || `/${m[1]}`.toLowerCase() !== azure.pathname.toLowerCase()) return null
  const project = `${azure.origin}/${m[1]}/${m[2]}/_git/`
  return { url: `${project}${m[3]}`, rule: [project, `${t.prefix}v3/${m[1]}/${m[2]}/`] }
}

// PLATFORM§52 ADR-0035
export async function rewriteRulesFor(
  a: Pick<GitAccount, 'platform' | 'url'>,
  urls: string[],
  hostnameOf: (dest: string, port?: string) => Promise<string | null>
): Promise<RepoRemotes> {
  if (a.platform === 'other') return { rules: [] }
  const out: RepoRemotes = { rules: [] }
  const add = (rule: RewriteRule): void => {
    if (!out.rules.some(([, from]) => from === rule[1])) out.rules.push(rule)
  }
  const server = new URL(credentialUrlOf(a))
  const sshHost = sshHostOf(a)
  for (const url of urls) {
    if (/^https?:\/\//i.test(url)) {
      try {
        const u = new URL(url)
        if (u.origin === server.origin && !u.username) add([url, url])
      } catch {}
      continue
    }
    const t = sshTarget(url)
    if (!t) continue
    const host = (await hostnameOf(t.dest, t.port))?.toLowerCase()
    if (host !== sshHost) continue
    const https = httpsOf(a, t)
    if (!https) continue
    add(https.rule)
    add([https.url, url])
    out.ssh ??= { url, dest: t.dest, ...(t.port ? { port: t.port } : {}) }
  }
  if (out.ssh && a.platform !== 'azure') {
    add([httpsBase(a), `git@${sshHost}:`])
    add([httpsBase(a), `ssh://git@${sshHost}/`])
  }
  return out
}
