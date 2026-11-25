import { execFile } from 'child_process'

export type Exec = (cmd: string, args: string[]) => Promise<string>

// PLATFORM§3
export function makeExec(timeoutMs: number): Exec {
  return (cmd, args) =>
    new Promise((resolve) => {
      execFile(cmd, args, { maxBuffer: 8 * 1024 * 1024, timeout: timeoutMs }, (err, stdout) => {
        if (err && (err.killed || err.signal)) return resolve('')
        resolve(typeof stdout === 'string' ? stdout : '')
      })
    })
}
