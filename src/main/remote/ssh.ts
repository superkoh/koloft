import { execFile } from 'child_process'
import fs from 'fs'

// Every ssh Koloft runs for a remote workspace carries the same options: the first
// connection becomes the shared master and every later command rides it, so a
// password or second factor is typed once, in the tab terminal. Background commands
// add BatchMode and can therefore never stop to ask for anything.

/** unix socket paths cap at 104 bytes on macOS (sun_path), which rules out the
 *  userData folder; `%C` keeps the file name short whatever the host string is */
export function defaultControlDir(): string {
  return `/tmp/koloft-${process.getuid?.() ?? 0}`
}

/** ssh does not create the ControlPath folder itself — with it missing every command
 *  fails at once with "No such file or directory" */
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
  /** null = killed by the local timeout (a command riding the master has no connect
   *  phase, so ssh's own ConnectTimeout never applies to it) */
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
        // a string code is node's own failure to run it — a missing binary, or output
        // past maxBuffer; only a kill (the timeout, or a signal) leaves no code at all
        else if (typeof err.code === 'string')
          resolve({ code: 127, stdout, stderr: stderr + String(err) })
        else resolve({ code: null, stdout, stderr })
      }
    )
    // execFile hands the child an open (never-closed) stdin pipe, so anything reading
    // stdin would block on it until the timeout instead of seeing end-of-file.
    child.stdin?.end()
  })
}

/** One background command on the machine. `-n` so it can never eat the terminal's
 *  keystrokes; BatchMode so it can never ask for a password. */
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

/** Pull one remote folder into a local one over the shared master connection.
 *  `extra` is the per-folder flag set (see remote/sync.ts). */
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
      // a non-login shell on a macOS machine has no /opt/homebrew/bin on PATH
      '--rsync-path=PATH=/opt/homebrew/bin:/usr/local/bin:$PATH rsync',
      `${host}:${remoteDir}/`,
      `${localDir}/`
    ],
    opts.timeoutMs ?? 12_000
  )
}
