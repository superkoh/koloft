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

export function sshOptions(controlDir: string, batch: boolean): string[] {
  const o = [
    '-o',
    'ControlMaster=auto',
    '-o',
    `ControlPath=${controlDir}/%C`,
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

export interface RunResult {
  // PLATFORM§33
  code: number | null
  stdout: string
  stderr: string
}

function run(bin: string, args: string[], timeoutMs: number): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = execFile(
      bin,
      args,
      { timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 32 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (!err) resolve({ code: 0, stdout, stderr })
        else if (typeof err.code === 'number') resolve({ code: err.code, stdout, stderr })
        // PLATFORM§27
        else if (typeof err.code === 'string')
          resolve({ code: 127, stdout, stderr: stderr + String(err) })
        else resolve({ code: null, stdout, stderr })
      }
    )
    // PLATFORM§27
    child.stdin?.end()
  })
}

export function runSsh(
  host: string,
  remoteCmd: string,
  opts: { controlDir: string; timeoutMs?: number }
): Promise<RunResult> {
  return run(
    'ssh',
    ['-n', ...sshOptions(opts.controlDir, true), host, remoteCmd],
    opts.timeoutMs ?? 10_000
  )
}

export interface BytesResult {
  code: number | null
  stdout: Buffer
  stderr: string
}

export function runSshBytes(
  host: string,
  remoteCmd: string,
  opts: { controlDir: string; timeoutMs?: number; input?: Buffer }
): Promise<BytesResult> {
  const args = [
    ...(opts.input ? [] : ['-n']),
    ...sshOptions(opts.controlDir, true),
    host,
    remoteCmd
  ]
  return new Promise((resolve) => {
    const child = execFile(
      'ssh',
      args,
      {
        timeout: opts.timeoutMs ?? 10_000,
        killSignal: 'SIGKILL',
        maxBuffer: 64 * 1024 * 1024,
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
      `ssh ${sshOptions(opts.controlDir, true).join(' ')}`,
      // PLATFORM§33
      '--rsync-path=PATH=/opt/homebrew/bin:/usr/local/bin:$PATH rsync',
      `${host}:${remoteDir}/`,
      `${localDir}/`
    ],
    opts.timeoutMs ?? 12_000
  )
}
