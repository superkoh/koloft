import { execFile, spawn } from 'child_process'
import fs from 'fs'
import readline from 'readline'
import { pipeline, Transform, type Readable, type TransformCallback } from 'stream'

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
    'RequestTTY=no',
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
  if (batch) o.push('-o', 'BatchMode=yes')
  return o
}

const MASTER_FULL = 'Session open refused by peer'

const spilledHosts = new Set<string>()

export function backgroundOptions(host: string, controlDir: string): string[] {
  return sshOptions(controlDir, true, spilledHosts.has(host) ? SPILL_MASTER : SHARED_MASTER)
}

export const SSH_LINK_BROKE_EXIT = 255

export function sshLinkBroke(r: { code: number | null }): boolean {
  return r.code === null || r.code === SSH_LINK_BROKE_EXIT
}

// PLATFORM§33
function noteMasterRoom<R extends { code: number | null; stderr: string }>(host: string, r: R): R {
  if (r.stderr.includes(MASTER_FULL)) spilledHosts.add(host)
  else if (r.code === SSH_LINK_BROKE_EXIT) spilledHosts.delete(host)
  return r
}

const NEEDS_SOMEONE_TO_SIGN_IN =
  /Permission denied|Host key verification failed|Too many authentication failures|passphrase/i
// PLATFORM§34
const SHELL_PRINTS_AT_LOGIN = /unexpected tag|protocol version mismatch|is your shell clean/i

export function needsSignIn(r: { code: number | null; stderr: string }): boolean {
  return r.code === SSH_LINK_BROKE_EXIT && NEEDS_SOMEONE_TO_SIGN_IN.test(r.stderr)
}

export function machineOutOfReach(r: { code: number | null; stderr: string }): boolean {
  return r.code === SSH_LINK_BROKE_EXIT && !needsSignIn(r) && !r.stderr.includes(MASTER_FULL)
}

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

export const ANSWER_STARTS = 'koloft-answer-starts-here'
const ANSWER_LINE = `${ANSWER_STARTS}\n`
export const ECHO_THE_MARK = `echo ${ANSWER_STARTS}; `

// PLATFORM§33
export function answerOf(remoteCmd: string, stdout: Buffer): Buffer {
  const at = remoteCmd.includes(ANSWER_STARTS) ? stdout.indexOf(ANSWER_LINE) : -1
  return at < 0 ? stdout : stdout.subarray(at + ANSWER_LINE.length)
}

// PLATFORM§33
export function answerStreamOf(remoteCmd: string, stdout: Readable): Readable {
  if (!remoteCmd.includes(ANSWER_STARTS)) return stdout
  let markMayStartIn: Buffer | null = Buffer.alloc(0)
  const transform = (chunk: Buffer, _: unknown, done: TransformCallback): void => {
    if (!markMayStartIn) return done(null, chunk)
    const seen = Buffer.concat([markMayStartIn, chunk])
    const at = seen.indexOf(ANSWER_LINE)
    if (at < 0) {
      markMayStartIn = seen.subarray(Math.max(0, seen.length - ANSWER_LINE.length + 1))
      return done()
    }
    markMayStartIn = null
    const answer = seen.subarray(at + ANSWER_LINE.length)
    done(null, answer.length ? answer : undefined)
  }
  return pipeline(stdout, new Transform({ transform }), () => {})
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
    child.stdin?.on('error', () => {})
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
  opts: { controlDir: string; timeoutMs?: number; input?: Buffer }
): Promise<RunResult> {
  return runSshBytes(host, remoteCmd, { ...opts, maxBuffer: 32 * 1024 * 1024 }).then((r) => ({
    ...r,
    stdout: r.stdout.toString('utf8')
  }))
}

export function runMasterCommand(
  host: string,
  op: string[],
  opts: { controlDir: string }
): Promise<RunResult> {
  return run('ssh', [...sshOptions(opts.controlDir, true), ...op, host], 10_000)
}

// PLATFORM§41
export function masterCommandOutlivingKoloft(
  host: string,
  op: string[],
  opts: { controlDir: string }
): void {
  spawn('ssh', [...sshOptions(opts.controlDir, true), ...op, host], {
    detached: true,
    stdio: 'ignore'
  }).unref()
}

export function runSshBytes(
  host: string,
  remoteCmd: string,
  opts: { controlDir: string; timeoutMs?: number; input?: Buffer; maxBuffer?: number }
): Promise<BytesResult> {
  const sent = markedFirst(remoteCmd)
  const args = [
    ...(opts.input ? [] : ['-n']),
    ...backgroundOptions(host, opts.controlDir),
    host,
    sent
  ]
  return runBytes('ssh', args, {
    timeoutMs: opts.timeoutMs ?? 10_000,
    maxBuffer: opts.maxBuffer ?? 64 * 1024 * 1024,
    input: opts.input
  }).then((r) => noteMasterRoom(host, { ...r, stdout: answerOf(sent, r.stdout) }))
}

// PLATFORM§33
function markedFirst(remoteCmd: string): string {
  return remoteCmd.includes(ECHO_THE_MARK) ? remoteCmd : `${ECHO_THE_MARK}${remoteCmd}`
}

const STDERR_TAIL_KEPT = 4096

export function listenOverSsh(
  host: string,
  remoteCmd: string,
  opts: { controlDir: string },
  onLine: (line: string) => void,
  onEnd: () => void
): () => void {
  const sent = markedFirst(remoteCmd)
  const child = spawn('ssh', ['-n', ...backgroundOptions(host, opts.controlDir), host, sent], {
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let stderr = ''
  let answering = false
  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    if (answering) onLine(line)
    else answering = line.endsWith(ANSWER_STARTS)
  })
  child.stderr
    .setEncoding('utf8')
    .on('data', (chunk: string) => (stderr = (stderr + chunk).slice(-STDERR_TAIL_KEPT)))
  child.on('error', () => {})
  child.on('close', (code) => {
    noteMasterRoom(host, { code, stderr })
    onEnd()
  })
  return () => child.kill()
}

// PLATFORM§33 CC§13
export async function writeToMachineSocket(
  host: string,
  socketPath: string,
  data: string,
  opts: { controlDir: string }
): Promise<void> {
  const r = await runBytes(
    'ssh',
    [...backgroundOptions(host, opts.controlDir), '-W', socketPath, host],
    { timeoutMs: 10_000, maxBuffer: 1024 * 1024, input: Buffer.from(data) }
  )
  if (r.code !== 0)
    throw new Error(
      `the session on ${host} did not take the message (${r.stderr.trim() || `ssh exited with ${r.code}`}).`
    )
}

// PLATFORM§34
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
      `${host}:${remoteDir}/`,
      `${localDir}/`
    ],
    opts.timeoutMs ?? 12_000
  ).then((r) => noteMasterRoom(host, r))
}
