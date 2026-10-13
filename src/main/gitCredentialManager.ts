import { spawn } from 'child_process'
import fs from 'fs'
import path from 'path'
import type { GitPlatform } from '@shared/types'
import type { GitCredential } from './gitAuthRequests'
import { withoutConfigEntries } from './gitConfigFile'

const GCM_SIGN_IN_TIMEOUT_MS = 10 * 60_000
const GCM_QUIET_TIMEOUT_MS = 20_000
const BROWSER_OPENED = /Opening browser using .*?(https?:\/\/\S+)/

const PROVIDER: Partial<Record<GitPlatform, string>> = {
  gitlab: 'gitlab',
  bitbucket: 'bitbucket',
  gitea: 'generic'
}

export interface GcmAccount {
  platform: GitPlatform
  url: string
  gcmNamespace?: string
}

export interface GcmDeps {
  bin: string | undefined
  stateDir: string
  env(): NodeJS.ProcessEnv
}

export interface GcmSignIn {
  done: Promise<GitCredential | { error: string }>
  cancel(): void
}

interface Ran {
  code: number | null
  stdout: string
  stderr: string
}

export function parseCredentialOutput(stdout: string): GitCredential | null {
  const fields = new Map<string, string>()
  for (const line of stdout.split('\n')) {
    const at = line.indexOf('=')
    if (at > 0) fields.set(line.slice(0, at), line.slice(at + 1))
  }
  const password = fields.get('password')
  return password ? { username: fields.get('username') ?? '', password } : null
}

export function browserUrlIn(trace: string): string | undefined {
  return BROWSER_OPENED.exec(trace)?.[1]
}

// PLATFORM§50
export function credentialRequest(
  a: GcmAccount,
  at: { host?: string; path?: string } = {}
): string {
  const u = new URL(a.url)
  return [
    `protocol=${u.protocol.replace(/:$/, '')}`,
    `host=${at.host ?? u.host}`,
    ...(at.path ? [`path=${at.path}`] : []),
    ...(a.platform === 'gitea' ? ['wwwauth[]=Basic realm="Gitea"'] : []),
    '',
    ''
  ].join('\n')
}

// PLATFORM§50 ADR-0034
export class CredentialManager {
  private queues = new Map<string, Promise<unknown>>()

  constructor(private d: GcmDeps) {}

  available(): boolean {
    return !!(process.env.KOLOFT_TEST_GCM || this.d.bin)
  }

  private configMade = false

  private configFile(): string {
    const file = path.join(this.d.stateDir, 'gitconfig')
    if (this.configMade) return file
    fs.mkdirSync(this.d.stateDir, { recursive: true, mode: 0o700 })
    if (!fs.existsSync(file)) fs.writeFileSync(file, '', { mode: 0o600 })
    this.configMade = true
    return file
  }

  private env(
    a: GcmAccount,
    namespace: string,
    signIn: boolean,
    provider = PROVIDER[a.platform] ?? 'generic'
  ): NodeJS.ProcessEnv {
    const out: NodeJS.ProcessEnv = {}
    for (const [k, v] of Object.entries(withoutConfigEntries(this.d.env())))
      if (!k.startsWith('GCM_') && k !== 'GIT_TERMINAL_PROMPT') out[k] = v
    const keychainFile = process.env.KOLOFT_KEYCHAIN_FILE
    Object.assign(out, {
      GCM_NAMESPACE: namespace,
      GCM_PROVIDER: provider,
      GCM_GUI_PROMPT: '0',
      GCM_GITLAB_AUTHMODES: 'browser',
      GCM_BITBUCKET_AUTHMODES: 'oauth',
      GCM_OAUTH_AUTHMODES: 'browser',
      GIT_CONFIG_GLOBAL: this.configFile(),
      GIT_CONFIG_NOSYSTEM: '1',
      ...(keychainFile
        ? {
            GCM_CREDENTIAL_STORE: 'plaintext',
            GCM_PLAINTEXT_STORE_PATH: path.join(path.dirname(keychainFile), 'gcm-store')
          }
        : { GCM_CREDENTIAL_STORE: 'keychain' }),
      ...(signIn ? { GCM_TRACE: '1' } : { GCM_INTERACTIVE: 'never', GIT_TERMINAL_PROMPT: '0' })
    })
    if (process.env.KOLOFT_TEST_GCM) out.ELECTRON_RUN_AS_NODE = '1'
    return out
  }

  private spawnGcm(
    op: string,
    input: string,
    env: NodeJS.ProcessEnv,
    timeoutMs: number,
    onStderr?: (text: string) => void
  ): { ran: Promise<Ran>; kill(): void } {
    const fake = process.env.KOLOFT_TEST_GCM
    const child = fake
      ? spawn(process.execPath, [fake, op], { env, cwd: this.d.stateDir })
      : spawn(this.d.bin!, [op], { env, cwd: this.d.stateDir })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (c: Buffer) => (stdout += c.toString()))
    child.stderr.on('data', (c: Buffer) => {
      stderr += c.toString()
      onStderr?.(stderr)
    })
    child.stdin.on('error', () => {})
    child.stdin.end(input)
    const timer = setTimeout(() => child.kill(), timeoutMs)
    const ran = new Promise<Ran>((resolve) => {
      child.on('error', () => resolve({ code: null, stdout, stderr }))
      child.on('close', (code) => {
        clearTimeout(timer)
        resolve({ code, stdout, stderr })
      })
    })
    return { ran, kill: () => child.kill() }
  }

  private queued<T>(namespace: string, job: () => Promise<T>): Promise<T> {
    const before = this.queues.get(namespace) ?? Promise.resolve()
    const run = before.then(job, job)
    this.queues.set(
      namespace,
      run.catch(() => {})
    )
    return run
  }

  private quiet(
    op: string,
    a: GcmAccount,
    at: { host?: string; path?: string } = {},
    provider?: string
  ): Promise<Ran | null> {
    const namespace = a.gcmNamespace
    if (!namespace || !this.available()) return Promise.resolve(null)
    return this.queued(
      namespace,
      () =>
        this.spawnGcm(
          op,
          credentialRequest(a, at),
          this.env(a, namespace, false, provider),
          GCM_QUIET_TIMEOUT_MS
        ).ran
    )
  }

  async get(a: GcmAccount): Promise<GitCredential | null> {
    const r = await this.quiet('get', a)
    return r?.code === 0 ? parseCredentialOutput(r.stdout) : null
  }

  async erase(a: GcmAccount): Promise<void> {
    const host = new URL(a.url).host
    for (const at of [
      {},
      { host: `oauth-refresh-token.${host}` },
      { host: `refresh_token.${host}` },
      { path: 'refresh_token' }
    ])
      await this.quiet('erase', a, at, 'generic')
  }

  signIn(a: GcmAccount & { gcmNamespace: string }, onBrowser: (url: string) => void): GcmSignIn {
    let seen: string | undefined
    const run = this.spawnGcm(
      'get',
      credentialRequest(a),
      this.env(a, a.gcmNamespace, true),
      GCM_SIGN_IN_TIMEOUT_MS,
      (stderr) => {
        const url = seen ? undefined : browserUrlIn(stderr)
        if (url) onBrowser((seen = url))
      }
    )
    const done = run.ran.then((r) => {
      const cred = r.code === 0 ? parseCredentialOutput(r.stdout) : null
      return cred ?? { error: lastPlainLine(r.stderr) }
    })
    return { done, cancel: run.kill }
  }
}

function lastPlainLine(stderr: string): string {
  return (
    stderr
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !/^\d{2}:\d{2}:\d{2}\.\d+ /.test(l))
      .at(-1) ?? ''
  )
}
