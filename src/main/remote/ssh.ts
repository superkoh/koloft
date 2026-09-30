import { execFile } from 'child_process'
import fs from 'fs'

// PLATFORM§3
export function defaultControlDir(): string {
  return `/tmp/koloft-${process.getuid?.() ?? 0}`
}

// PLATFORM§33
export function ensureControlDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  fs.chmodSync(dir, 0o700)
}

const SHARED_MASTER = '%C'
const SPILL_MASTER = '%C-spill'

// PLATFORM§33
export function sshOptions(controlDir: string, batch: boolean, master = SHARED_MASTER): string[] {
  const o = [
    '-o',
    'RemoteCommand=none',
    '-o',
    'ControlMaster=auto',
    '-o',
    `ControlPath=${controlDir}/${master}`,
    '-o',
    'ControlPersist=yes',
    '-o',
    'ServerAliveInterval=15',
    '-o',
    'ServerAliveCountMax=3'
  ]
  if (batch) o.push('-o', 'BatchMode=yes', '-o', 'RequestTTY=no')
  return o
}

const MASTER_FULL = 'Session open refused by peer'

const spilledHosts = new Set<string>()

function backgroundOptions(host: string, controlDir: string): string[] {
  return sshOptions(controlDir, true, spilledHosts.has(host) ? SPILL_MASTER : SHARED_MASTER)
}

// PLATFORM§33
function noteMasterRoom(host: string, r: { code: number | null; stderr: string }): void {
  if (r.stderr.includes(MASTER_FULL)) spilledHosts.add(host)
  else if (r.code === SSH_COULD_NOT_CONNECT) spilledHosts.delete(host)
}

const SSH_COULD_NOT_CONNECT = 255

const NEEDS_SOMEONE_TO_SIGN_IN =
  /Permission denied|Host key verification failed|Too many authentication failures|passphrase/i
// PLATFORM§34
const SHELL_PRINTS_AT_LOGIN = /unexpected tag|protocol version mismatch|is your shell clean/i

export function problemOf(r: { code: number | null; stderr: string }): string {
  if (r.stderr.includes(MASTER_FULL))
    return 'Too many tabs share one connection to this machine (its sshd MaxSessions) — close some, or raise MaxSessions there'
  if (SHELL_PRINTS_AT_LOGIN.test(r.stderr))
    return "This machine's shell prints text when it starts (see ~/.bashrc there); session sync needs it to print nothing"
  const last = r.stderr
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .at(-1)
  const said = last ?? (r.code === null ? 'ssh timed out' : `ssh exited with ${r.code}`)
  return NEEDS_SOMEONE_TO_SIGN_IN.test(r.stderr)
    ? `${said} — start a session on this machine and sign in there`
    : said
}

export interface RunResult {
  // PLATFORM§33
  code: number | null
  stdout: string
  stderr: string
}

export interface BytesResult {
  code: number | null
  stdout: Buffer
  stderr: string
}

function runBytes(
  bin: string,
  args: string[],
  opts: { timeoutMs: number; maxBuffer: number; input?: Buffer }
): Promise<BytesResult> {
  return new Promise((resolve) => {
    const child = execFile(
      bin,
      args,
      {
        timeout: opts.timeoutMs,
        killSignal: 'SIGKILL',
        maxBuffer: opts.maxBuffer,
        encoding: 'buffer'
      },
      (err, stdout, stderr) => {
        const errText = stderr.toString('utf8')
        if (!err) resolve({ code: 0, stdout, stderr: errText })
        else if (typeof err.code === 'number') resolve({ code: err.code, stdout, stderr: errText })
        // PLATFORM§27
        else if (typeof err.code === 'string')
          resolve({ code: 127, stdout, stderr: errText + String(err) })
        else resolve({ code: null, stdout, stderr: errText })
      }
    )
    // PLATFORM§27
    child.stdin?.end(opts.input)
  })
}

async function run(bin: string, args: string[], timeoutMs: number): Promise<RunResult> {
  const r = await runBytes(bin, args, { timeoutMs, maxBuffer: 32 * 1024 * 1024 })
  return { ...r, stdout: r.stdout.toString('utf8') }
}

export function runSsh(
  host: string,
  remoteCmd: string,
  opts: { controlDir: string; timeoutMs?: number }
): Promise<RunResult> {
  return runSshBytes(host, remoteCmd, { ...opts, maxBuffer: 32 * 1024 * 1024 }).then((r) => ({
    ...r,
    stdout: r.stdout.toString('utf8')
  }))
}

export function runSshBytes(
  host: string,
  remoteCmd: string,
  opts: { controlDir: string; timeoutMs?: number; input?: Buffer; maxBuffer?: number }
): Promise<BytesResult> {
  const args = [
    ...(opts.input ? [] : ['-n']),
    ...backgroundOptions(host, opts.controlDir),
    host,
    remoteCmd
  ]
  return runBytes('ssh', args, {
    timeoutMs: opts.timeoutMs ?? 10_000,
    maxBuffer: opts.maxBuffer ?? 64 * 1024 * 1024,
    input: opts.input
  }).then((r) => {
    noteMasterRoom(host, r)
    return r
  })
}

// PLATFORM§34
const REMOTE_RSYNC_ON_ANY_LOGIN_SHELL = `sh -c 'PATH=/opt/homebrew/bin:/usr/local/bin:$PATH exec rsync "$@"' sh`

export function rsyncPull(
  host: string,
  remoteDir: string,
  localDir: string,
  extra: string[],
  opts: { controlDir: string; timeoutMs?: number }
): Promise<RunResult> {
  fs.mkdirSync(localDir, { recursive: true })
  return run(
    'rsync',
    [
      '-a',
      ...extra,
      '--timeout=10',
      '-e',
      `ssh ${backgroundOptions(host, opts.controlDir).join(' ')}`,
      `--rsync-path=${REMOTE_RSYNC_ON_ANY_LOGIN_SHELL}`,
      `${host}:${remoteDir}/`,
      `${localDir}/`
    ],
    opts.timeoutMs ?? 12_000
  ).then((r) => {
    noteMasterRoom(host, r)
    return r
  })
}
