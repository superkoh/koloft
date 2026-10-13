import { execFile, spawn, type ChildProcess } from 'child_process'
import { randomUUID } from 'crypto'
import fs from 'fs'
import path from 'path'
import type { GitLoginProgress, GitLoginStart } from '@shared/types'
import { githubHostEntry } from './gitClues'
import type { whoami } from './githubApi'

const SANDBOX_EXEC = '/usr/bin/sandbox-exec'
const KEYCHAIN_TOOL = '/usr/bin/security'
const SANDBOX_CHECK_TIMEOUT_MS = 5_000
const GH_LOGIN_TIMEOUT_MS = 10 * 60_000
const LOGIN_DIR_PREFIX = 'gh-login-'
const PROFILE_FILE = 'gh-login.sb'

// PLATFORM§47 ADR-0032
export const DENY_KEYCHAIN_PROFILE =
  '(version 1)\n(allow default)\n(deny process-exec (literal "/usr/bin/security"))\n'

// PLATFORM§47 ADR-0032
export const GH_LOGIN_ARGS = [
  'auth',
  'login',
  '--web',
  '--insecure-storage',
  '--git-protocol',
  'https',
  '--hostname',
  'github.com',
  '-s',
  'repo,read:org,gist,workflow',
  '--clipboard=false'
]

function runInSandbox(
  profileFile: string,
  argv: string[]
): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      SANDBOX_EXEC,
      ['-f', profileFile, ...argv],
      { timeout: SANDBOX_CHECK_TIMEOUT_MS },
      (err, _stdout, stderr) => {
        const code = err ? (typeof err.code === 'number' ? err.code : null) : 0
        resolve({ code, stderr: String(stderr) })
      }
    )
  })
}

// PLATFORM§47 ADR-0032
export async function sandboxBlocksKeychain(profileFile: string): Promise<boolean> {
  const [control, keychain] = await Promise.all([
    runInSandbox(profileFile, ['/usr/bin/true']),
    runInSandbox(profileFile, [KEYCHAIN_TOOL, 'help'])
  ])
  return (
    control.code === 0 && keychain.code !== 0 && /Operation not permitted/.test(keychain.stderr)
  )
}

const ONE_TIME_CODE = /one-time code:\s*([A-Z0-9]{4}-[A-Z0-9]{4})/
const DEVICE_URL = /Open this URL[^:]*:\s*(https?:\/\/\S+)/

// PLATFORM§47 ADR-0032
export function parseLoginOutput(text: string): { code?: string; url?: string } {
  const code = ONE_TIME_CODE.exec(text)?.[1]
  const url = DEVICE_URL.exec(text)?.[1]
  return { ...(code ? { code } : {}), ...(url ? { url } : {}) }
}

export function readHostsYml(text: string): { login: string; token: string } | null {
  const { user, token } = githubHostEntry(text)
  return user && token ? { login: user, token } : null
}

export function removeStaleLoginDirs(userData: string): void {
  let names: string[]
  try {
    names = fs.readdirSync(userData)
  } catch {
    return
  }
  for (const n of names)
    if (n.startsWith(LOGIN_DIR_PREFIX))
      fs.rmSync(path.join(userData, n), { recursive: true, force: true })
}

export interface GithubLoginDeps {
  ghBin: string | undefined
  userData: string
  openInBrowser(url: string): void
  progress(p: GitLoginProgress): void
  whoami: typeof whoami
  save(
    a: { host: 'github.com'; login: string; id: number; name: string },
    token: string
  ): Promise<void>
}

interface LoginRun {
  dir: string
  child?: ChildProcess
  url?: string
  stderr: string
  cancelled: boolean
  timer?: NodeJS.Timeout
}

function fakeLoginInputs(): Record<string, string> {
  const out: Record<string, string> = { ELECTRON_RUN_AS_NODE: '1' }
  for (const [k, v] of Object.entries(process.env))
    if (k.startsWith('KOLOFT_FAKE_') && v !== undefined) out[k] = v
  return out
}

function lastLine(text: string): string | undefined {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .at(-1)
}

// PLATFORM§47 ADR-0032
export class GithubLogin {
  private run: LoginRun | null = null

  constructor(private d: GithubLoginDeps) {}

  async start(): Promise<GitLoginStart> {
    if (this.run) return { ok: false, error: 'busy' }
    const fake = process.env.KOLOFT_TEST_GH_LOGIN
    if (!fake && !this.d.ghBin) return { ok: false, error: 'no-gh' }
    const run: LoginRun = {
      dir: path.join(this.d.userData, LOGIN_DIR_PREFIX + randomUUID()),
      stderr: '',
      cancelled: false
    }
    this.run = run
    this.d.progress({ phase: 'checking' })
    const profile = path.join(this.d.userData, PROFILE_FILE)
    if (!fake) {
      fs.writeFileSync(profile, DENY_KEYCHAIN_PROFILE)
      const blocked = await sandboxBlocksKeychain(profile)
      if (run.cancelled) return { ok: true }
      if (!blocked) {
        this.run = null
        return { ok: false, error: 'no-sandbox' }
      }
    }
    const cfg = path.join(run.dir, 'cfg')
    const home = path.join(run.dir, 'home')
    const emptyBin = path.join(run.dir, 'emptybin')
    for (const d of [cfg, home, emptyBin]) fs.mkdirSync(d, { recursive: true, mode: 0o700 })
    const env: Record<string, string> = {
      PATH: emptyBin,
      HOME: home,
      GH_CONFIG_DIR: cfg,
      GH_PROMPT_DISABLED: '1',
      GH_NO_UPDATE_NOTIFIER: '1',
      GH_NO_EXTENSION_UPDATE_NOTIFIER: '1',
      GH_TELEMETRY: '0'
    }
    const child = fake
      ? spawn(process.execPath, [fake, ...GH_LOGIN_ARGS], {
          env: { ...env, ...fakeLoginInputs() },
          stdio: ['ignore', 'ignore', 'pipe']
        })
      : spawn(SANDBOX_EXEC, ['-f', profile, this.d.ghBin!, ...GH_LOGIN_ARGS], {
          env,
          stdio: ['ignore', 'ignore', 'pipe']
        })
    run.child = child
    run.timer = setTimeout(
      () => this.end(run, 'GitHub sign-in timed out. Try again.'),
      GH_LOGIN_TIMEOUT_MS
    )
    child.stderr!.on('data', (chunk: Buffer) => {
      run.stderr += chunk.toString()
      if (run.url) return
      const { code, url } = parseLoginOutput(run.stderr)
      if (!code || !url) return
      run.url = url
      this.d.progress({ phase: 'code', code, url })
      // PLATFORM§47
      this.d.openInBrowser(url)
    })
    child.on('error', () => this.end(run, 'Could not start gh to sign in.'))
    child.on('close', (code) => {
      if (code === 0) void this.finish(run, cfg)
      else
        this.end(
          run,
          `GitHub sign-in did not finish${lastLine(run.stderr) ? `: ${lastLine(run.stderr)}` : '.'}`
        )
    })
    return { ok: true }
  }

  cancel(): void {
    const run = this.run
    if (!run) return
    run.cancelled = true
    this.end(run, null)
  }

  openInBrowser(): void {
    if (this.run?.url) this.d.openInBrowser(this.run.url)
  }

  private end(run: LoginRun, failure: string | null): void {
    if (this.run !== run) return
    this.run = null
    clearTimeout(run.timer)
    run.child?.kill()
    fs.rmSync(run.dir, { recursive: true, force: true })
    if (failure && !run.cancelled) this.d.progress({ phase: 'failed', message: failure })
  }

  private async finish(run: LoginRun, cfg: string): Promise<void> {
    if (this.run !== run) return
    let signedIn: { login: string; token: string } | null = null
    try {
      signedIn = readHostsYml(fs.readFileSync(path.join(cfg, 'hosts.yml'), 'utf8'))
    } catch {}
    if (!signedIn) return this.end(run, 'gh finished but saved no GitHub sign-in.')
    const token = signedIn.token
    clearTimeout(run.timer)
    fs.rmSync(run.dir, { recursive: true, force: true })
    const me = await this.d.whoami(token)
    if (this.run !== run) return
    if (!me.ok) {
      const why =
        me.error === 'offline'
          ? 'GitHub could not be reached to read the new account. Check the connection and try again.'
          : me.error === 'expired'
            ? 'GitHub did not accept the new sign-in. Try again.'
            : 'GitHub did not say which account signed in. Try again.'
      return this.end(run, why)
    }
    try {
      await this.d.save({ host: 'github.com', login: me.login, id: me.id, name: me.name }, token)
    } catch {
      return this.end(run, 'Koloft could not save the GitHub account.')
    }
    if (this.run !== run) return
    this.end(run, null)
    this.d.progress({ phase: 'saved', login: me.login })
  }
}
