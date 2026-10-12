import path from 'path'
import type { GitAccount, GitAccountSuggestion, GitClueReason } from '@shared/types'
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
import type { pushAccess } from './githubApi'

export interface GitRun {
  code: number | null
  stdout: string
  stderr: string
}

export interface SuggestDeps {
  git(
    cwd: string,
    args: string[],
    opts: { env: NodeJS.ProcessEnv; input?: string }
  ): Promise<GitRun>
  ssh(args: string[]): Promise<GitRun>
  readFile(p: string): string | null
  home: string
  env: NodeJS.ProcessEnv
  githubUrl: string
  accounts(): GitAccount[]
  token(login: string): Promise<string | null>
  pushAccess: typeof pushAccess
  repoOf(ws: string): Promise<{ owner: string; name: string } | null>
}

const NONE: GitAccountSuggestion = { kind: 'none' }
const NO_HELPERS_NO_PROMPTS = ['-c', 'credential.helper=', '-c', 'core.askPass=']
const COMMIT_EMAILS_LOOKED_AT = 50
const CONFIG_ENTRY_VARIABLE = /^GIT_CONFIG_(COUNT|KEY_\d+|VALUE_\d+)$/
const SCP_LIKE = /^(?:([^@/]+)@)?([^:/]+):(?!\/)/

export function clueEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(env)) if (!CONFIG_ENTRY_VARIABLE.test(k)) out[k] = v
  out.GIT_TERMINAL_PROMPT = '0'
  out.GIT_ASKPASS = '/usr/bin/false'
  out.SSH_ASKPASS = '/usr/bin/false'
  return out
}

type Remote =
  { kind: 'https'; urls: string[] } | { kind: 'ssh'; dest: string; port?: string; sshG: string }

interface Clue {
  login: string
  reason: GitClueReason
}

export async function suggestFor(
  wsPath: string,
  opts: { network: boolean },
  d: SuggestDeps
): Promise<GitAccountSuggestion> {
  const env = clueEnv(d.env)
  const git = async (args: string[], input?: string): Promise<GitRun> =>
    d.git(wsPath, args, { env, ...(input === undefined ? {} : { input }) })
  const out = async (args: string[]): Promise<string | null> => {
    const r = await git(args)
    return r.code === 0 && r.stdout.trim() ? r.stdout.trim() : null
  }
  const remote = await githubRemote(out, d)
  if (!remote) return NONE
  const clue = await firstClue(remote, opts.network, git, out, d)
  if (clue) return decide(clue, wsPath, opts.network, d)
  return noClue(wsPath, opts.network, out, d)
}

async function githubRemote(
  out: (args: string[]) => Promise<string | null>,
  d: SuggestDeps
): Promise<Remote | null> {
  const branch = await out(['symbolic-ref', '--short', '-q', 'HEAD'])
  const cfg = (key: string): Promise<string | null> => out(['config', '--get', key])
  const fetchRemote = (branch && (await cfg(`branch.${branch}.remote`))) || 'origin'
  const pushRemote =
    (branch && (await cfg(`branch.${branch}.pushRemote`))) ||
    (await cfg('remote.pushDefault')) ||
    fetchRemote
  const pushUrl = await out(['remote', 'get-url', '--push', pushRemote])
  if (!pushUrl) return null
  if (/^https?:\/\//.test(pushUrl)) {
    if (!sameHost(pushUrl, d.githubUrl)) return null
    const fetchUrl = await out(['remote', 'get-url', fetchRemote])
    return {
      kind: 'https',
      urls: fetchUrl && fetchUrl !== pushUrl ? [pushUrl, fetchUrl] : [pushUrl]
    }
  }
  const target = sshTarget(pushUrl)
  if (!target) return null
  const g = await d.ssh(['-G', ...(target.port ? ['-p', target.port] : []), target.dest])
  if (g.code !== 0 || sshSetting(g.stdout, 'hostname') !== new URL(d.githubUrl).hostname)
    return null
  return { kind: 'ssh', ...target, sshG: g.stdout }
}

function sameHost(url: string, githubUrl: string): boolean {
  try {
    return new URL(url).host === new URL(githubUrl).host
  } catch {
    return false
  }
}

function sshTarget(url: string): { dest: string; port?: string } | null {
  if (url.startsWith('ssh://')) {
    try {
      const u = new URL(url)
      const dest = u.username ? `${decodeURIComponent(u.username)}@${u.hostname}` : u.hostname
      return { dest, ...(u.port ? { port: u.port } : {}) }
    } catch {
      return null
    }
  }
  const m = SCP_LIKE.exec(url)
  return m ? { dest: m[1] ? `${m[1]}@${m[2]}` : m[2] } : null
}

function withoutUser(url: string): string {
  const u = new URL(url)
  u.username = ''
  u.password = ''
  return u.toString()
}

async function firstClue(
  remote: Remote,
  network: boolean,
  git: (args: string[], input?: string) => Promise<GitRun>,
  out: (args: string[]) => Promise<string | null>,
  d: SuggestDeps
): Promise<Clue | null> {
  if (remote.kind === 'https') {
    const named = remote.urls
      .map(loginFromRemoteUrl)
      .filter((l): l is string => !!l && l !== 'discard')
    const distinct = new Set(named.map((l) => l.toLowerCase()))
    if (distinct.size === 1) return { login: named[0], reason: 'url-user' }
    if (distinct.size > 1) return null
    const fill = await git(
      [...NO_HELPERS_NO_PROMPTS, 'credential', 'fill'],
      `url=${withoutUser(remote.urls[0])}\n\n`
    )
    const configured = loginFromCredentialFill(fill.stderr)
    if (configured) return { login: configured, reason: 'config-user' }
    if (d.env.GH_TOKEN || d.env.GITHUB_TOKEN) return null
    const helpers = (await out(['config', '--get-regexp', '^credential\\..*helper$'])) ?? ''
    const ghLogin = ghActiveLogin(readGhHosts(d), usesGhCredentialHelper(helpers), true)
    return ghLogin ? { login: ghLogin, reason: 'gh-user' } : null
  }
  if (!network) return null
  if (await out(['config', '--get', 'core.sshCommand'])) return null
  if (sshClueSkipped(remote.sshG, d.env)) return null
  const hello = await d.ssh([
    ...SSH_SAFE_OPTIONS,
    ...(remote.port ? ['-p', remote.port] : []),
    remote.dest
  ])
  const login = loginFromSshGreeting(hello.stderr)
  return login ? { login, reason: 'ssh-greeting' } : null
}

function readGhHosts(d: SuggestDeps): string {
  const dir =
    d.env.GH_CONFIG_DIR ||
    (d.env.XDG_CONFIG_HOME
      ? path.join(d.env.XDG_CONFIG_HOME, 'gh')
      : path.join(d.home, '.config', 'gh'))
  return d.readFile(path.join(dir, 'hosts.yml')) ?? ''
}

async function decide(
  clue: Clue,
  wsPath: string,
  network: boolean,
  d: SuggestDeps
): Promise<GitAccountSuggestion> {
  const account = d.accounts().find((a) => a.login.toLowerCase() === clue.login.toLowerCase())
  if (!account) return { kind: 'add', login: clue.login, reason: clue.reason }
  const use: GitAccountSuggestion = { kind: 'use', login: account.login, reason: clue.reason }
  if (!network) return use
  const repo = await d.repoOf(wsPath)
  if (!repo) return use
  const token = await d.token(account.login)
  if (!token) return { kind: 'cannot-push', login: account.login, reason: clue.reason }
  const access = await d.pushAccess(token, repo.owner, repo.name)
  if (access.kind === 'offline') return NONE
  if (access.kind === 'org-blocked')
    return { kind: 'org-blocked', login: account.login, org: access.org }
  if (access.kind === 'push' && access.allowed) return use
  return { kind: 'cannot-push', login: account.login, reason: clue.reason }
}

async function noClue(
  wsPath: string,
  network: boolean,
  out: (args: string[]) => Promise<string | null>,
  d: SuggestDeps
): Promise<GitAccountSuggestion> {
  const hint = await commitEmailHint(out, d)
  const fallback = hint ? hint : NONE
  if (!network) return fallback
  const repo = await d.repoOf(wsPath)
  if (!repo) return fallback
  const pushers: string[] = []
  for (const a of d.accounts()) {
    const token = await d.token(a.login)
    if (!token) continue
    const access = await d.pushAccess(token, repo.owner, repo.name)
    if (access.kind === 'offline') return fallback
    if (access.kind === 'push' && access.allowed) pushers.push(a.login)
  }
  if (pushers.length === 1) return { kind: 'only-one-can-push', login: pushers[0] }
  return fallback
}

async function commitEmailHint(
  out: (args: string[]) => Promise<string | null>,
  d: SuggestDeps
): Promise<GitAccountSuggestion | null> {
  const accounts = d.accounts()
  const reflog =
    (await out(['log', '-g', `-n${COMMIT_EMAILS_LOOKED_AT}`, '--format=%gs%x09%ce'])) ?? ''
  const madeHere = reflog
    .split('\n')
    .filter((l) => l.startsWith('commit'))
    .map((l) => l.split('\t')[1] ?? '')
  const fromCommits = loginFromCommitEmails(madeHere, accounts)
  if (fromCommits) return { kind: 'hint', login: fromCommits, reason: 'commit-email' }
  const configured = await out(['config', '--get', 'user.email'])
  const fromConfig = configured ? loginFromCommitEmails([configured], accounts) : null
  return fromConfig ? { kind: 'hint', login: fromConfig, reason: 'commit-email' } : null
}
