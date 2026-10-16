import path from 'path'
import type { GitAccount, GitAccountSuggestion, GitClueReason, GitPlatform } from '@shared/types'
import {
  ghActiveLogin,
  loginFromCommitEmails,
  loginFromCredentialFill,
  loginFromRemoteUrl,
  loginFromSshGreeting,
  SSH_SAFE_OPTIONS,
  sshClueSkipped,
  sshSetting,
  usesGhCredentialHelper
} from './gitClues'
import type { PushAccess } from './githubApi'
import type { GitRunResult } from './gitSteps'
import type { GitTarget } from './gitPlatformApi'
import { apiTargetOf, withoutConfigEntries } from './gitConfigFile'
import { AZURE_HOST, AZURE_SSH_HOST, azureSshPath, sshTarget, trimRepoPath } from './gitSshRemotes'
import { GIT_PUBLIC_HOSTS, isGhPlatform } from '@shared/gitAccountOps'

export interface SuggestDeps {
  git(
    cwd: string,
    args: string[],
    opts: { env: NodeJS.ProcessEnv; input?: string }
  ): Promise<GitRunResult>
  ssh(args: string[]): Promise<GitRunResult>
  readFile(p: string): Promise<string | null>
  home: string
  env: NodeJS.ProcessEnv
  githubUrl: string
  accounts(): GitAccount[]
  serverOf(a: GitAccount): string
  token(a: GitAccount): Promise<string | null>
  pushAccess(t: GitTarget, token: string, repoPath: string): Promise<PushAccess>
}

const OFF: GitAccountSuggestion = { kind: 'off' }
const NO_HELPERS_NO_PROMPTS = ['-c', 'credential.helper=', '-c', 'core.askPass=']
const COMMIT_EMAILS_LOOKED_AT = 50
const SSH_GREETS: GitPlatform[] = ['github', 'ghes', 'gitlab', 'gitea']

export function clueEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out = withoutConfigEntries(env)
  out.GIT_TERMINAL_PROMPT = '0'
  out.GIT_ASKPASS = '/usr/bin/false'
  out.SSH_ASKPASS = '/usr/bin/false'
  return out
}

type Remote =
  | { kind: 'https'; host: string; urls: string[]; path: string }
  | { kind: 'ssh'; host: string; dest: string; port?: string; sshG: string; path: string }

interface Clue {
  login: string
  reason: GitClueReason
}

interface Here {
  remote: Remote
  host: string
  accounts: GitAccount[]
  platform: GitPlatform | undefined
}

export async function suggestFor(
  wsPath: string,
  opts: { network: boolean; pushChecks?: boolean },
  d: SuggestDeps
): Promise<GitAccountSuggestion> {
  const env = clueEnv(d.env)
  const git = async (args: string[], input?: string): Promise<GitRunResult> =>
    d.git(wsPath, args, { env, ...(input === undefined ? {} : { input }) })
  const out = async (args: string[]): Promise<string | null> => {
    const r = await git(args)
    return r.code === 0 && r.stdout.trim() ? r.stdout.trim() : null
  }
  const remote = await pushRemote(out, d)
  if (!remote) return OFF
  const here = whereIs(remote, d)
  if (!here) return OFF
  const clue = await firstClue(here, opts.network, git, out, d)
  const checks = opts.network && opts.pushChecks !== false
  if (clue) return decide(clue, here, checks, d)
  return noClue(here, checks, out, d)
}

function whereIs(remote: Remote, d: SuggestDeps): Here | null {
  const accounts = d.accounts().filter((a) => {
    const server = new URL(d.serverOf(a))
    return remote.kind === 'https' ? server.host === remote.host : server.hostname === remote.host
  })
  const githubHost = new URL(d.githubUrl)[remote.kind === 'https' ? 'host' : 'hostname']
  const known = remote.host === githubHost || GIT_PUBLIC_HOSTS.includes(remote.host)
  if (!accounts.length && !known) return null
  const host = accounts[0]?.host ?? (remote.host === githubHost ? 'github.com' : remote.host)
  const platform = accounts[0]?.platform ?? (remote.host === githubHost ? 'github' : undefined)
  const repoPath = (a: GitAccount | undefined): string => {
    const base = a && a.platform !== 'azure' ? new URL(a.url).pathname.replace(/\/+$/, '') : ''
    return base && remote.path.startsWith(`${base.slice(1)}/`)
      ? remote.path.slice(base.length)
      : remote.path
  }
  return { remote: { ...remote, path: repoPath(accounts[0]) }, host, accounts, platform }
}

async function pushRemote(
  out: (args: string[]) => Promise<string | null>,
  d: SuggestDeps
): Promise<Remote | null> {
  const branch = await out(['symbolic-ref', '--short', '-q', 'HEAD'])
  const cfg = (key: string): Promise<string | null> => out(['config', '--get', key])
  const fetchRemote = (branch && (await cfg(`branch.${branch}.remote`))) || 'origin'
  const pushRemoteName =
    (branch && (await cfg(`branch.${branch}.pushRemote`))) ||
    (await cfg('remote.pushDefault')) ||
    fetchRemote
  const pushUrl = await out(['remote', 'get-url', '--push', pushRemoteName])
  if (!pushUrl) return null
  if (/^https?:\/\//.test(pushUrl)) {
    let u: URL
    try {
      u = new URL(pushUrl)
    } catch {
      return null
    }
    const fetchUrl = await out(['remote', 'get-url', fetchRemote])
    return {
      kind: 'https',
      host: u.host.toLowerCase(),
      path: trimRepoPath(decodeURIComponent(u.pathname)),
      urls: fetchUrl && fetchUrl !== pushUrl ? [pushUrl, fetchUrl] : [pushUrl]
    }
  }
  const target = sshTarget(pushUrl)
  if (!target) return null
  const { dest, port } = target
  const g = await d.ssh(['-G', ...(port ? ['-p', port] : []), dest])
  const hostname = g.code === 0 ? sshSetting(g.stdout, 'hostname')?.toLowerCase() : undefined
  if (!hostname) return null
  return {
    kind: 'ssh',
    host: hostname === AZURE_SSH_HOST ? AZURE_HOST : hostname,
    dest,
    ...(port ? { port } : {}),
    path: azureSshPath(trimRepoPath(target.path)),
    sshG: g.stdout
  }
}

function withoutUser(url: string): string {
  const u = new URL(url)
  u.username = ''
  u.password = ''
  return u.toString()
}

async function firstClue(
  here: Here,
  network: boolean,
  git: (args: string[], input?: string) => Promise<GitRunResult>,
  out: (args: string[]) => Promise<string | null>,
  d: SuggestDeps
): Promise<Clue | null> {
  const { remote, platform } = here
  if (remote.kind === 'https') {
    const named =
      platform === 'azure'
        ? []
        : remote.urls.map(loginFromRemoteUrl).filter((l): l is string => !!l && l !== 'discard')
    const distinct = new Set(named.map((l) => l.toLowerCase()))
    if (distinct.size === 1) return { login: named[0], reason: 'url-user' }
    if (distinct.size > 1) return null
    const fill = await git(
      [...NO_HELPERS_NO_PROMPTS, 'credential', 'fill'],
      `url=${withoutUser(remote.urls[0])}\n\n`
    )
    const configured = loginFromCredentialFill(fill.stderr)
    if (configured) return { login: configured, reason: 'config-user' }
    if (!platform || !isGhPlatform(platform)) return null
    if (d.env.GH_TOKEN || d.env.GITHUB_TOKEN || d.env.GH_ENTERPRISE_TOKEN) return null
    const helpers = (await out(['config', '--get-regexp', '^credential\\..*helper$'])) ?? ''
    const ghLogin = ghActiveLogin(
      await readGhHosts(d),
      usesGhCredentialHelper(helpers, here.host),
      here.host
    )
    return ghLogin ? { login: ghLogin, reason: 'gh-user' } : null
  }
  if (!network || !platform || !SSH_GREETS.includes(platform)) return null
  if (await out(['config', '--get', 'core.sshCommand'])) return null
  if (sshClueSkipped(remote.sshG, d.env)) return null
  const hello = await d.ssh([
    ...SSH_SAFE_OPTIONS,
    ...(remote.port ? ['-p', remote.port] : []),
    remote.dest
  ])
  const login = loginFromSshGreeting(hello)
  return login ? { login, reason: 'ssh-greeting' } : null
}

async function readGhHosts(d: SuggestDeps): Promise<string> {
  const dir =
    d.env.GH_CONFIG_DIR ||
    (d.env.XDG_CONFIG_HOME
      ? path.join(d.env.XDG_CONFIG_HOME, 'gh')
      : path.join(d.home, '.config', 'gh'))
  return (await d.readFile(path.join(dir, 'hosts.yml'))) ?? ''
}

async function decide(
  clue: Clue,
  here: Here,
  network: boolean,
  d: SuggestDeps
): Promise<GitAccountSuggestion> {
  const host = here.host
  const account = here.accounts.find((a) => a.login.toLowerCase() === clue.login.toLowerCase())
  if (!account) return { kind: 'add', host, login: clue.login, reason: clue.reason }
  const use: GitAccountSuggestion = { kind: 'use', host, login: account.login, reason: clue.reason }
  if (!network || account.platform === 'other') return use
  const token = await d.token(account)
  if (!token) return { kind: 'cannot-push', host, login: account.login, reason: clue.reason }
  const access = await d.pushAccess(apiTargetOf(account), token, here.remote.path)
  if (access.kind === 'offline') return { kind: 'none', host }
  if (access.kind === 'org-blocked')
    return { kind: 'org-blocked', host, login: account.login, org: access.org }
  if (access.kind === 'push' && access.allowed) return use
  return { kind: 'cannot-push', host, login: account.login, reason: clue.reason }
}

async function noClue(
  here: Here,
  network: boolean,
  out: (args: string[]) => Promise<string | null>,
  d: SuggestDeps
): Promise<GitAccountSuggestion> {
  const host = here.host
  const none: GitAccountSuggestion = { kind: 'none', host }
  const accounts = here.accounts.filter((a) => a.platform !== 'other')
  const hint = await commitEmailHint(out, accounts, host)
  const fallback = hint ?? none
  if (!network || !accounts.length) return fallback
  const accesses = await Promise.all(
    accounts.map(async (a) => {
      const token = await d.token(a)
      return {
        login: a.login,
        access: token && (await d.pushAccess(apiTargetOf(a), token, here.remote.path))
      }
    })
  )
  if (accesses.some((x) => x.access && x.access.kind === 'offline')) return fallback
  const pushers = accesses
    .filter((x) => x.access && x.access.kind === 'push' && x.access.allowed)
    .map((x) => x.login)
  if (pushers.length === 1) return { kind: 'only-one-can-push', host, login: pushers[0] }
  const byDefault = accounts.find((a) => a.default && pushers.includes(a.login))
  return byDefault ? { kind: 'default-can-push', host, login: byDefault.login } : fallback
}

async function commitEmailHint(
  out: (args: string[]) => Promise<string | null>,
  accounts: GitAccount[],
  host: string
): Promise<GitAccountSuggestion | null> {
  if (!accounts.length) return null
  const reflog =
    (await out(['log', '-g', `-n${COMMIT_EMAILS_LOOKED_AT}`, '--format=%gs%x09%ce'])) ?? ''
  const madeHere = reflog
    .split('\n')
    .filter((l) => l.startsWith('commit'))
    .map((l) => l.split('\t')[1] ?? '')
  const fromCommits = loginFromCommitEmails(madeHere, accounts)
  if (fromCommits) return { kind: 'hint', host, login: fromCommits, reason: 'commit-email' }
  const configured = await out(['config', '--get', 'user.email'])
  const fromConfig = configured ? loginFromCommitEmails([configured], accounts) : null
  return fromConfig ? { kind: 'hint', host, login: fromConfig, reason: 'commit-email' } : null
}
