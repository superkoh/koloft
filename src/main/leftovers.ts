import { execFile } from 'child_process'
import type { LeftoverProcess } from '@shared/types'

export type Exec = (cmd: string, args: string[]) => Promise<string>

const SCAN_DEADLINE_MS = 5000

const defaultExec: Exec = (cmd, args) =>
  new Promise((resolve) => {
    execFile(cmd, args, { maxBuffer: 64 * 1024 * 1024, timeout: SCAN_DEADLINE_MS }, (err, stdout) =>
      resolve(err ? '' : stdout)
    )
  })

const SESSION_ENV = /(?:^|\s)CLAUDE_CODE_SESSION_ID=([0-9a-f-]{36})(?=\s|$)/
const ADOPTED_BY_LAUNCHD = 1

// CC§9 PLATFORM§3
export async function scanLeftovers(
  run: Exec = defaultExec
): Promise<Map<string, LeftoverProcess[]>> {
  const [withEnv, plain] = await Promise.all([
    run('ps', ['eww', '-Ao', 'pid=,ppid=,command=']),
    run('ps', ['-Ao', 'pid=,command='])
  ])
  const commandOf = new Map<number, string>()
  for (const line of plain.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(.*)$/)
    if (m) commandOf.set(Number(m[1]), m[2])
  }
  const out = new Map<string, LeftoverProcess[]>()
  for (const line of withEnv.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/)
    if (!m || Number(m[2]) !== ADOPTED_BY_LAUNCHD) continue
    const sid = m[3].match(SESSION_ENV)?.[1]
    if (!sid) continue
    const pid = Number(m[1])
    const list = out.get(sid) ?? []
    list.push({ pid, command: commandOf.get(pid) ?? '' })
    out.set(sid, list)
  }
  return out
}

export async function stopLeftover(
  sessionId: string,
  pid: number,
  run: Exec = defaultExec,
  kill: (pid: number) => void = (p) => process.kill(p, 'SIGTERM')
): Promise<boolean> {
  const current = await scanLeftovers(run)
  if (!current.get(sessionId)?.some((p) => p.pid === pid)) return false
  try {
    kill(pid)
    return true
  } catch {
    return false
  }
}
