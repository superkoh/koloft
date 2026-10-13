import { execFile } from 'child_process'
import { randomUUID } from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type {
  AccountStatus,
  GitAccount,
  GitAccountSuggestion,
  GitAccountView,
  GitHost,
  GitLoginProgress,
  GitLoginStart,
  GitRepoPick,
  GitTokenAddResult,
  WorkspaceGitAccount
} from '@shared/types'
import { gitTokenDelete, gitTokenRead, gitTokenWrite } from './accounts'
import {
  dismissSuggestion,
  listGitAccounts,
  listGitPicks,
  removeGitAccount,
  setDefaultGitAccount,
  setGitPick,
  suggestionDismissed,
  upsertGitAccount
} from './gitAccounts'
import { GitAccountChecks } from './gitAccountChecks'
import { suggestFor } from './gitAccountSuggest'
import { GitAuthRequests } from './gitAuthRequests'
import {
  GITHUB_URL,
  gitAccountsDir,
  gitConfigEnv,
  noreplyEmail,
  writeGitAccountConfigs
} from './gitConfigFile'
import { TOKEN_VARIABLES_GH_PREFERS } from './gitCredentialScripts'
import { GitRepoKeys } from './gitRepoKey'
import type { GitRunResult } from './gitSteps'
import { missingScope, pushAccess, whoami } from './githubApi'
import { GithubLogin } from './githubLogin'

const HOST: GitHost = 'github.com'
const CLUE_COMMAND_KILL_MS = 10_000
const REQUEST_DIR = /^koloft-git-(\d+)-/
const PICKED_WITHOUT_ASKING: GitAccountSuggestion['kind'][] = [
  'use',
  'only-one-can-push',
  'default-can-push'
]

export function newGitRequestDir(): string {
  return `/tmp/koloft-git-${process.pid}-${randomUUID()}`
}

export function sweepStaleGitRequestDirs(alive: (pid: number) => boolean): void {
  let names: string[] = []
  try {
    names = fs.readdirSync('/tmp')
  } catch {
    return
  }
  for (const n of names) {
    const pid = Number(REQUEST_DIR.exec(n)?.[1])
    if (pid && pid !== process.pid && !alive(pid))
      fs.rmSync(path.join('/tmp', n), { recursive: true, force: true })
  }
}

function runForClue(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string }
): Promise<GitRunResult> {
  return new Promise((resolve) => {
    const child = execFile(
      cmd,
      args,
      { cwd: opts.cwd, env: opts.env, timeout: CLUE_COMMAND_KILL_MS },
      (err, stdout, stderr) => {
        const code = (err as { code?: unknown } | null)?.code
        resolve({
          code: !err ? 0 : typeof code === 'number' ? code : null,
          stdout: String(stdout),
          stderr: String(stderr)
        })
      }
    )
    child.stdin?.end(opts.input ?? '')
  })
}

function readText(p: string): string | null {
  try {
    return fs.readFileSync(p, 'utf8')
  } catch {
    return null
  }
}

export interface GitAccountServiceDeps {
  userData: string
  requestDir: string
  gitHelper: string
  ghBin: string | undefined
  baseEnv(): Promise<NodeJS.ProcessEnv>
  repoOf(wsPath: string): Promise<{ owner: string; name: string } | null>
  openInBrowser(url: string): void
  progress(p: GitLoginProgress): void
  accountsChanged(views: GitAccountView[]): void
  picksChanged(): void
}

export class GitAccountService {
  private keys = new GitRepoKeys()
  private readonly master: string
  private accounts: GitAccount[] = []
  private picks: GitRepoPick[] = []
  private offline = new Set<string>()
  private found = new Map<string, GitAccountSuggestion>()
  private orgBlocked = new Map<string, { login: string; org: string }>()
  private requests: GitAuthRequests
  private checks: GitAccountChecks
  private login: GithubLogin

  constructor(private d: GitAccountServiceDeps) {
    this.master = this.reload()
    this.checks = new GitAccountChecks({
      accounts: () => this.accounts,
      token: (login) => gitTokenRead(HOST, login),
      whoami,
      setStatus: (login, status) => this.setStatus(login, status),
      setOffline: (login, offline) => {
        if (offline === this.offline.has(login)) return
        if (offline) this.offline.add(login)
        else this.offline.delete(login)
        this.accountsChanged()
      }
    })
    this.requests = new GitAuthRequests({
      token: gitTokenRead,
      rejected: (_host, login) => void this.checks.checkOne(login)
    })
    this.login = new GithubLogin({
      ghBin: d.ghBin,
      userData: d.userData,
      openInBrowser: d.openInBrowser,
      progress: d.progress,
      whoami,
      save: (a, token) => this.save(a, token)
    })
  }

  start(): void {
    fs.mkdirSync(this.d.requestDir, { recursive: true, mode: 0o700 })
    this.requests.watch(this.d.requestDir)
    this.checks.start()
  }

  stop(): void {
    this.login.cancel()
    fs.rmSync(this.d.requestDir, { recursive: true, force: true })
  }

  // ADR-0033
  configEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    return gitConfigEnv(env, this.master)
  }

  private reload(): string {
    this.accounts = listGitAccounts()
    this.picks = listGitPicks()
    return writeGitAccountConfigs(
      gitAccountsDir(this.d.userData),
      this.picks,
      this.accounts,
      this.d.gitHelper
    )
  }

  private account(login: string | undefined): GitAccount | undefined {
    return this.accounts.find((a) => a.login.toLowerCase() === login?.toLowerCase())
  }

  private pickFor(repo: string | null): GitAccount | undefined {
    return this.account(this.picks.find((p) => p.repo === repo)?.login)
  }

  async refreshRepoKeys(workspaces: string[]): Promise<void> {
    await this.keys.refresh(workspaces)
    this.accountsChanged()
  }

  views(): GitAccountView[] {
    return this.accounts.map((a) => ({
      ...a,
      usedBy: this.picks
        .filter((p) => p.login === a.login)
        .flatMap((p) => this.keys.workspacesOf(p.repo)),
      ...(this.offline.has(a.login) && { checkError: 'offline' as const })
    }))
  }

  private accountsChanged(): void {
    this.d.accountsChanged(this.views())
  }

  private changed(): void {
    this.reload()
    this.found.clear()
    this.accountsChanged()
    this.d.picksChanged()
  }

  private setStatus(login: string, status: AccountStatus): void {
    const a = this.account(login)
    if (!a) return
    upsertGitAccount({ ...a, status })
    this.changed()
  }

  pickedLogin(root: string): string | undefined {
    return this.pickFor(this.keys.known(root))?.login
  }

  async pickedAt(cwd: string): Promise<boolean> {
    return !!this.pickFor(await this.keys.resolve(cwd))
  }

  workspaceAccount(wsPath: string): WorkspaceGitAccount | undefined {
    const repo = this.keys.known(wsPath)
    const a = this.pickFor(repo)
    if (!repo || !a) return undefined
    const blocked = this.orgBlocked.get(repo)
    return {
      login: a.login,
      host: a.host,
      author: { name: a.name || a.login, email: noreplyEmail(a) },
      status: a.status,
      sharedWith: this.keys.workspacesOf(repo).filter((p) => p !== wsPath),
      ...(blocked?.login === a.login && { pushBlockedByOrg: blocked.org })
    }
  }

  private async envFor(account: GitAccount | undefined): Promise<NodeJS.ProcessEnv | undefined> {
    const token = account && (await gitTokenRead(account.host, account.login))
    if (!token) return undefined
    const env: NodeJS.ProcessEnv = { ...process.env, GH_TOKEN: token, GH_HOST: HOST }
    for (const k of TOKEN_VARIABLES_GH_PREFERS) delete env[k]
    return env
  }

  async ghEnv(root: string): Promise<NodeJS.ProcessEnv | undefined> {
    return this.envFor(this.pickFor(await this.keys.resolve(root)))
  }

  async ghEnvForRepo(
    slug: string | undefined,
    workspaces: string[]
  ): Promise<NodeJS.ProcessEnv | undefined> {
    for (const ws of slug ? workspaces : []) {
      const picked = this.pickFor(this.keys.known(ws))
      const repo = picked && (await this.d.repoOf(ws))
      if (repo && `${repo.owner}/${repo.name}` === slug) return this.envFor(picked)
    }
    return this.envFor(this.accounts.find((a) => a.default))
  }

  private async save(
    a: { host: GitHost; login: string; id: number; name: string },
    token: string
  ): Promise<void> {
    if (!(await gitTokenWrite(a.host, a.login, token))) throw new Error('keychain write failed')
    upsertGitAccount({
      ...a,
      default: false,
      status: 'ok',
      addedAt: this.account(a.login)?.addedAt ?? Date.now()
    })
    this.offline.delete(a.login)
    this.changed()
  }

  loginStart(): Promise<GitLoginStart> {
    return this.login.start()
  }

  loginCancel(): void {
    this.login.cancel()
  }

  loginBrowser(): void {
    this.login.openInBrowser()
  }

  checkAll(): void {
    void this.checks.checkAll()
  }

  async addToken(token: string): Promise<GitTokenAddResult> {
    const me = await whoami(token)
    if (!me.ok) return { ok: false, error: me.error === 'expired' ? 'rejected' : me.error }
    const scope = missingScope(me.scopes)
    if (scope) return { ok: false, error: 'missing-scope', scope }
    try {
      await this.save({ host: HOST, login: me.login, id: me.id, name: me.name }, token)
    } catch {
      return { ok: false, error: 'failed' }
    }
    return { ok: true, login: me.login }
  }

  async remove(login: string): Promise<void> {
    const a = this.account(login)
    if (!a) return
    await gitTokenDelete(a.host, a.login)
    removeGitAccount(a.login)
    this.offline.delete(a.login)
    this.changed()
  }

  makeDefault(login: string): void {
    setDefaultGitAccount(login)
    this.reload()
    this.accountsChanged()
  }

  async pick(wsPath: string, login: string | null): Promise<void> {
    const repo = await this.keys.resolve(wsPath)
    if (!repo) return
    setGitPick(repo, login)
    this.keys.set(wsPath, repo)
    this.orgBlocked.delete(repo)
    this.changed()
    const account = this.account(login ?? undefined)
    if (account) void this.checkOrgAccess(wsPath, repo, account)
  }

  private async checkOrgAccess(wsPath: string, repo: string, account: GitAccount): Promise<void> {
    const where = await this.d.repoOf(wsPath)
    const token = where && (await gitTokenRead(account.host, account.login))
    if (!where || !token) return
    const access = await pushAccess(token, where.owner, where.name)
    if (access.kind !== 'org-blocked' || this.pickFor(repo) !== this.account(account.login)) return
    this.orgBlocked.set(repo, { login: account.login, org: access.org })
    this.d.picksChanged()
  }

  private async suggestNow(wsPath: string, network: boolean): Promise<GitAccountSuggestion> {
    const env = await this.d.baseEnv()
    return suggestFor(
      wsPath,
      { network },
      {
        git: (cwd, args, opts) => runForClue('git', args, { cwd, ...opts }),
        ssh: (args) => runForClue('ssh', args, { env }),
        readFile: readText,
        home: os.homedir(),
        env,
        githubUrl: GITHUB_URL,
        accounts: () => this.accounts,
        token: (login) => gitTokenRead(HOST, login),
        pushAccess,
        repoOf: this.d.repoOf
      }
    )
  }

  async suggest(wsPath: string, network: boolean): Promise<GitAccountSuggestion> {
    const repo = await this.keys.resolve(wsPath)
    if (!repo || suggestionDismissed(repo)) return { kind: 'none' }
    const cached = this.found.get(wsPath)
    if (!network && cached) return cached
    const s = await this.suggestNow(wsPath, network)
    if (!network || s.kind !== 'none') this.found.set(wsPath, s)
    return s
  }

  async dismiss(wsPath: string): Promise<void> {
    const repo = await this.keys.resolve(wsPath)
    if (!repo) return
    dismissSuggestion(repo)
    this.found.delete(wsPath)
  }

  async autoPickNewWorkspace(wsPath: string): Promise<void> {
    if (this.accounts.length === 0) return
    const repo = await this.keys.resolve(wsPath)
    if (!repo || this.pickFor(repo)) return
    const s = await this.suggest(wsPath, true)
    if (PICKED_WITHOUT_ASKING.includes(s.kind) && 'login' in s) await this.pick(wsPath, s.login)
  }
}
