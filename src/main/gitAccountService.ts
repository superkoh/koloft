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
  GitLoginProgress,
  GitLoginStart,
  GitPlatform,
  GitRepoPick,
  GitTokenAdd,
  GitTokenAddResult,
  WorkspaceGitAccount
} from '@shared/types'
import {
  GITHUB_DOT_COM,
  GIT_LOGIN_RE,
  gitAccountId,
  gitAccountUrl,
  gitHostOf,
  gitSignIn
} from '@shared/gitAccountOps'
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
import { GitAccountChecks, type AccountHealth } from './gitAccountChecks'
import { suggestFor } from './gitAccountSuggest'
import { GitAuthRequests, type GitAuthRequest, type GitCredential } from './gitAuthRequests'
import {
  GITHUB_URL,
  credentialUrlOf,
  gitAccountsDir,
  gitConfigEnv,
  writeGitAccountConfigs
} from './gitConfigFile'
import { GH_TOKEN_VARIABLES } from './gitCredentialScripts'
import { CredentialManager, type GcmAccount, type GcmSignIn } from './gitCredentialManager'
import { GitRepoKeys } from './gitRepoKey'
import type { GitRunResult } from './gitSteps'
import { pushAccess } from './githubApi'
import {
  githubApiBase,
  identify,
  missingScopeOn,
  pushAccessOn,
  type GitTarget,
  type Identity
} from './gitPlatformApi'
import { GithubLogin, type GithubLoginDeps } from './githubLogin'

const CLUE_COMMAND_KILL_MS = 10_000
const REQUEST_DIR = /^koloft-git-(\d+)-/
const PICKED_WITHOUT_ASKING: GitAccountSuggestion['kind'][] = [
  'use',
  'only-one-can-push',
  'default-can-push'
]
const GH_PLATFORMS: GitPlatform[] = ['github', 'ghes']

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

function targetOf(a: Pick<GitAccount, 'platform' | 'url'>): GitTarget {
  return { platform: a.platform, url: a.platform === 'github' ? GITHUB_URL : a.url }
}

function serverName(platform: GitPlatform): string {
  return platform === 'github' || platform === 'ghes' ? 'GitHub' : 'The server'
}

function identityFailure(platform: GitPlatform, me: Identity & { ok: false }): string {
  const who = serverName(platform)
  if (me.error === 'offline')
    return `${who} could not be reached to read the new account. Check the connection and try again.`
  if (me.error === 'expired') return `${who} did not accept the new sign-in. Try again.`
  return `${who} did not say which account signed in. Try again.`
}

export interface GitAccountServiceDeps {
  userData: string
  requestDir: string
  gitHelper: string
  ghBin: string | undefined
  gcmBin: string | undefined
  gcmNamespacePrefix: string
  baseEnv(): Promise<NodeJS.ProcessEnv>
  repoOf(wsPath: string): Promise<{ owner: string; name: string } | null>
  openPage: GithubLoginDeps['openPage']
  openInBrowser(url: string): void
  progress(p: GitLoginProgress): void
  accountsChanged(views: GitAccountView[]): void
  picksChanged(): void
}

interface GcmRun {
  run: GcmSignIn
  account: GcmAccount
  url?: string
}

export class GitAccountService {
  private keys = new GitRepoKeys()
  private readonly master: string
  private accounts: GitAccount[] = []
  private picks: GitRepoPick[] = []
  private offline = new Set<string>()
  private found = new Map<string, GitAccountSuggestion>()
  private orgBlocked = new Map<string, { id: string; org: string }>()
  private requests: GitAuthRequests
  private checks: GitAccountChecks
  private login: GithubLogin
  private gcm: CredentialManager
  private gcmRun: GcmRun | null = null
  private ghesUrl = ''
  private loginEnv: NodeJS.ProcessEnv = { ...process.env }

  constructor(private d: GitAccountServiceDeps) {
    this.master = this.reload()
    this.gcm = new CredentialManager({
      bin: d.gcmBin,
      stateDir: path.join(gitAccountsDir(d.userData), 'gcm'),
      env: () => this.loginEnv
    })
    this.checks = new GitAccountChecks({
      accounts: () => this.accounts,
      health: (a) => this.health(a),
      setStatus: (id, status) => this.setStatus(id, status),
      setOffline: (id, offline) => {
        if (offline === this.offline.has(id)) return
        if (offline) this.offline.add(id)
        else this.offline.delete(id)
        this.accountsChanged()
      }
    })
    this.requests = new GitAuthRequests({
      credential: (req) => this.credential(req),
      ghToken: (id) => this.ghToken(id),
      rejected: (id) => this.rejected(id)
    })
    this.login = new GithubLogin({
      ghBin: d.ghBin,
      userData: d.userData,
      openPage: d.openPage,
      openInBrowser: d.openInBrowser,
      progress: d.progress,
      signedIn: (host, token) =>
        host === 'github.com'
          ? this.signedIn('github', GITHUB_DOT_COM, { token })
          : this.signedIn('ghes', this.ghesUrl, { token })
    })
  }

  start(): void {
    fs.mkdirSync(this.d.requestDir, { recursive: true, mode: 0o700 })
    this.requests.watch(this.d.requestDir)
    this.checks.start()
    void this.d.baseEnv().then((env) => (this.loginEnv = env))
  }

  stop(): void {
    this.login.cancel()
    this.loginCancel()
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

  private account(id: string | undefined): GitAccount | undefined {
    return this.accounts.find((a) => a.id === id)
  }

  private pickFor(repo: string | null): GitAccount | undefined {
    return this.account(this.picks.find((p) => p.repo === repo)?.account)
  }

  private async secret(a: GitAccount): Promise<GitCredential | null> {
    if (a.gcmNamespace) {
      const cred = await this.gcm.get(a)
      return cred && a.platform === 'gitea' ? { ...cred, username: a.login } : cred
    }
    const token = await gitTokenRead(a.host, a.login)
    return token ? { username: a.login, password: token } : null
  }

  private async token(a: GitAccount): Promise<string | null> {
    return (await this.secret(a))?.password ?? null
  }

  // PLATFORM§46
  private async credential(req: GitAuthRequest): Promise<GitCredential | null> {
    const a = this.account(req.account)
    if (!a) return null
    const server = new URL(credentialUrlOf(a))
    if (req.host.toLowerCase() !== server.host || `${req.protocol}:` !== server.protocol)
      return null
    return this.secret(a)
  }

  private async ghToken(id: string): Promise<string | null> {
    const a = this.account(id)
    return a && GH_PLATFORMS.includes(a.platform) ? this.token(a) : null
  }

  private rejected(id: string): void {
    const a = this.account(id)
    if (a?.platform === 'other') this.setStatus(id, 'expired')
    else if (a) void this.checks.checkOne(id)
  }

  private async health(a: GitAccount): Promise<AccountHealth> {
    if (a.platform === 'other') return 'unknown'
    const token = await this.token(a)
    if (!token && !a.gcmNamespace) return 'unknown'
    const me = await identify(targetOf(a), token ?? '')
    if (me.ok) return token ? 'ok' : 'unknown'
    if (me.error === 'failed') return 'unknown'
    return me.error
  }

  async refreshRepoKeys(workspaces: string[]): Promise<void> {
    await this.keys.refresh(workspaces)
    this.accountsChanged()
  }

  views(): GitAccountView[] {
    return this.accounts.map((a) => ({
      ...a,
      usedBy: this.picks
        .filter((p) => p.account === a.id)
        .flatMap((p) => this.keys.workspacesOf(p.repo)),
      ...(this.offline.has(a.id) && { checkError: 'offline' as const })
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

  private setStatus(id: string, status: AccountStatus): void {
    const a = this.account(id)
    if (!a) return
    upsertGitAccount({ ...a, status })
    this.changed()
  }

  pickedAccount(root: string): string | undefined {
    return this.pickFor(this.keys.known(root))?.id
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
      id: a.id,
      login: a.login,
      host: a.host,
      platform: a.platform,
      ...(a.author && { author: a.author }),
      status: a.status,
      sharedWith: this.keys.workspacesOf(repo).filter((p) => p !== wsPath),
      ...(blocked?.id === a.id && { pushBlockedByOrg: blocked.org })
    }
  }

  private async envFor(account: GitAccount | undefined): Promise<NodeJS.ProcessEnv | undefined> {
    const token = account?.platform === 'github' ? await this.token(account) : null
    if (!token) return undefined
    const env: NodeJS.ProcessEnv = { ...process.env }
    for (const k of GH_TOKEN_VARIABLES) delete env[k]
    return { ...env, GH_TOKEN: token, GH_HOST: 'github.com' }
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
    return this.envFor(this.accounts.find((a) => a.platform === 'github' && a.default))
  }

  private async save(
    platform: GitPlatform,
    url: string,
    me: { login: string; author?: GitAccount['author'] },
    secret: { token: string } | { gcmNamespace: string }
  ): Promise<GitAccount> {
    const host = gitHostOf(url)
    const id = gitAccountId(host, me.login)
    const before = this.account(id)
    if ('token' in secret) {
      if (!(await gitTokenWrite(host, me.login, secret.token)))
        throw new Error('keychain write failed')
    }
    const account: GitAccount = {
      id,
      platform,
      url,
      host,
      login: me.login,
      ...(me.author && { author: me.author }),
      ...('gcmNamespace' in secret && { gcmNamespace: secret.gcmNamespace }),
      default: false,
      status: 'ok',
      addedAt: before?.addedAt ?? Date.now()
    }
    upsertGitAccount(account)
    if (before?.gcmNamespace && before.gcmNamespace !== account.gcmNamespace)
      void this.gcm.erase(before)
    if (before && !before.gcmNamespace && 'gcmNamespace' in secret)
      void gitTokenDelete(before.host, before.login)
    this.offline.delete(id)
    this.changed()
    return account
  }

  private async signedIn(
    platform: GitPlatform,
    url: string,
    secret: { token: string } | { gcmNamespace: string; cred: GitCredential }
  ): Promise<{ ok: true; login: string } | { ok: false; message: string }> {
    const token = 'token' in secret ? secret.token : secret.cred.password
    const me = await identify(targetOf({ platform, url }), token)
    if (!me.ok) return { ok: false, message: identityFailure(platform, me) }
    try {
      await this.save(
        platform,
        url,
        me,
        'token' in secret ? secret : { gcmNamespace: secret.gcmNamespace }
      )
    } catch {
      return { ok: false, message: 'Koloft could not save the account.' }
    }
    return { ok: true, login: me.login }
  }

  async loginStart(platform: GitPlatform, raw: string): Promise<GitLoginStart> {
    if (this.gcmRun || this.login.running) return { ok: false, error: 'busy' }
    const url = gitAccountUrl(platform, raw)
    const how = url && gitSignIn(platform, url)
    if (!url || !how || how === 'token') return { ok: false, error: 'bad-url' }
    if (platform === 'github') return this.login.start('github.com')
    if (how === 'gh') {
      this.ghesUrl = url
      return this.login.start(gitHostOf(url))
    }
    if (!this.gcm.available()) return { ok: false, error: 'no-gcm' }
    return this.gcmLogin(platform, url)
  }

  // PLATFORM§50 ADR-0034
  private gcmLogin(platform: GitPlatform, url: string): GitLoginStart {
    const namespace = `${this.d.gcmNamespacePrefix}-${randomUUID()}`
    const account = { platform, url, gcmNamespace: namespace }
    this.d.progress({ phase: 'browser' })
    const g: GcmRun = {
      account,
      run: this.gcm.signIn(account, (opened) => {
        g.url = opened
        if (this.gcmRun === g) this.d.progress({ phase: 'browser', url: opened })
      })
    }
    this.gcmRun = g
    void g.run.done.then(async (r) => {
      if (this.gcmRun !== g) return
      const fail = (message: string): void => {
        this.gcmRun = null
        void this.gcm.erase(account)
        this.d.progress({ phase: 'failed', message })
      }
      if ('error' in r) return fail(`Sign-in did not finish${r.error ? `: ${r.error}` : '.'}`)
      const saved = await this.signedIn(platform, url, { gcmNamespace: namespace, cred: r })
      if (this.gcmRun !== g) return
      if (!saved.ok) return fail(saved.message)
      this.gcmRun = null
      this.d.progress({ phase: 'saved', login: saved.login })
    })
    return { ok: true }
  }

  loginCancel(): void {
    this.login.cancel()
    const g = this.gcmRun
    if (!g) return
    this.gcmRun = null
    g.run.cancel()
    void g.run.done.then(() => this.gcm.erase(g.account))
  }

  loginWindow(): void {
    this.login.showWindow()
  }

  loginBrowser(): void {
    if (this.gcmRun?.url) this.d.openInBrowser(this.gcmRun.url)
    else this.login.openInBrowser()
  }

  checkAll(): void {
    void this.checks.checkAll()
  }

  async addToken(add: GitTokenAdd): Promise<GitTokenAddResult> {
    const url = gitAccountUrl(add.platform, add.url)
    if (!url) return { ok: false, error: 'bad-url' }
    let me: { login: string; author?: GitAccount['author'] }
    if (add.platform === 'other') {
      const login = add.username?.trim() ?? ''
      if (!GIT_LOGIN_RE.test(login)) return { ok: false, error: 'rejected' }
      me = { login }
    } else {
      const found = await identify(targetOf({ platform: add.platform, url }), add.token)
      if (!found.ok)
        return { ok: false, error: found.error === 'expired' ? 'rejected' : found.error }
      const scope = missingScopeOn(add.platform, found.scopes)
      if (scope) return { ok: false, error: 'missing-scope', scope }
      me = found
    }
    try {
      await this.save(add.platform, url, me, { token: add.token })
    } catch {
      return { ok: false, error: 'failed' }
    }
    return { ok: true, login: me.login }
  }

  async remove(id: string): Promise<void> {
    const a = this.account(id)
    if (!a) return
    if (a.gcmNamespace) await this.gcm.erase(a)
    else await gitTokenDelete(a.host, a.login)
    removeGitAccount(a.id)
    this.offline.delete(a.id)
    this.changed()
  }

  makeDefault(id: string): void {
    setDefaultGitAccount(id)
    this.reload()
    this.accountsChanged()
  }

  async pick(wsPath: string, id: string | null): Promise<void> {
    const repo = await this.keys.resolve(wsPath)
    if (!repo) return
    setGitPick(repo, id)
    this.keys.set(wsPath, repo)
    this.orgBlocked.delete(repo)
    this.changed()
    const account = this.account(id ?? undefined)
    if (account && GH_PLATFORMS.includes(account.platform))
      void this.checkOrgAccess(wsPath, repo, account)
  }

  private async checkOrgAccess(wsPath: string, repo: string, account: GitAccount): Promise<void> {
    const where = await this.d.repoOf(wsPath)
    const token = where && (await this.token(account))
    if (!where || !token) return
    const access = await pushAccess(
      token,
      where.owner,
      where.name,
      githubApiBase(targetOf(account))
    )
    if (access.kind !== 'org-blocked' || this.pickFor(repo) !== this.account(account.id)) return
    this.orgBlocked.set(repo, { id: account.id, org: access.org })
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
        serverOf: credentialUrlOf,
        token: (a) => this.token(a),
        pushAccess: pushAccessOn
      }
    )
  }

  async suggest(wsPath: string, network: boolean): Promise<GitAccountSuggestion> {
    const repo = await this.keys.resolve(wsPath)
    if (!repo) return { kind: 'off' }
    const cached = this.found.get(wsPath)
    if (!network && cached) return this.unlessDismissed(repo, cached)
    const s = await this.suggestNow(wsPath, network && !suggestionDismissed(repo))
    if (!network || s.kind !== 'none') this.found.set(wsPath, s)
    return this.unlessDismissed(repo, s)
  }

  private unlessDismissed(repo: string, s: GitAccountSuggestion): GitAccountSuggestion {
    return s.kind !== 'off' && suggestionDismissed(repo) ? { kind: 'none', host: s.host } : s
  }

  async dismiss(wsPath: string): Promise<void> {
    const repo = await this.keys.resolve(wsPath)
    if (!repo) return
    dismissSuggestion(repo)
  }

  async autoPickNewWorkspace(wsPath: string): Promise<void> {
    if (this.accounts.length === 0) return
    const repo = await this.keys.resolve(wsPath)
    if (!repo || this.pickFor(repo)) return
    const s = await this.suggest(wsPath, true)
    if (!PICKED_WITHOUT_ASKING.includes(s.kind) || !('login' in s)) return
    const account = this.accounts.find(
      (a) => a.host === s.host && a.login.toLowerCase() === s.login.toLowerCase()
    )
    if (account) await this.pick(wsPath, account.id)
  }

  accountFor(host: string, login: string): string | undefined {
    return this.accounts.find(
      (a) => a.host === host && a.login.toLowerCase() === login.toLowerCase()
    )?.id
  }
}
