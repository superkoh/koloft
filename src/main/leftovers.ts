import type { LeftoverProcess } from '@shared/types'
import { makeExec, type Exec } from './taskProcs'

const SCAN_DEADLINE_MS = 5000
const defaultExec = makeExec(SCAN_DEADLINE_MS)

const ADOPTED_BY_LAUNCHD = 1

const sessionOf = (commandWithEnv: string): string | undefined =>
  commandWithEnv.match(/(?:^|\s)CLAUDE_CODE_SESSION_ID=([0-9a-f-]{36})(?=\s|$)/m)?.[1]

async function orphansByLaunchd(run: Exec): Promise<Map<number, string>> {
  const commandOf = new Map<number, string>()
  for (const line of (await run('ps', ['-Ao', 'pid=,ppid=,command='])).split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/)
    if (m && Number(m[2]) === ADOPTED_BY_LAUNCHD) commandOf.set(Number(m[1]), m[3])
  }
  return commandOf
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const WAIT_FOR_LEFTOVER_EXIT_MS = 3000
const LEFTOVER_EXIT_POLL_MS = 100

// CODEX§5
export async function endCodexAppServersLeftByACrash(
  marker: string,
  run: Exec = defaultExec
): Promise<void> {
  const leftovers = [...(await orphansByLaunchd(run))]
    .filter(([, command]) => command.includes('app-server --stdio') && command.includes(marker))
    .map(([pid]) => pid)
  for (const pid of leftovers) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {}
  }
  const until = Date.now() + WAIT_FOR_LEFTOVER_EXIT_MS
  while (leftovers.some(pidAlive) && Date.now() < until)
    await new Promise((r) => setTimeout(r, LEFTOVER_EXIT_POLL_MS))
}

// CC§9 PLATFORM§3
export async function scanLeftovers(
  run: Exec = defaultExec
): Promise<Record<string, LeftoverProcess[]>> {
  const commandOf = await orphansByLaunchd(run)
  const out: Record<string, LeftoverProcess[]> = {}
  if (!commandOf.size) return out
  const withEnv = await run('ps', [
    'eww',
    '-o',
    'pid=,command=',
    '-p',
    [...commandOf.keys()].join(',')
  ])
  const envOf = new Map<number, string>()
  let current = 0
  for (const line of withEnv.split('\n')) {
    const m = line.match(/^\s*(\d+)\s/)
    if (m && commandOf.has(Number(m[1]))) current = Number(m[1])
    if (current) envOf.set(current, (envOf.get(current) ?? '') + ' ' + line)
  }
  for (const [pid, env] of envOf) {
    const sid = sessionOf(env)
    if (sid) (out[sid] ??= []).push({ pid, command: commandOf.get(pid) ?? '' })
  }
  return out
}

export async function stopLeftover(
  sessionId: string,
  pid: number,
  run: Exec = defaultExec,
  kill: (pid: number) => void = (p) => process.kill(p, 'SIGTERM')
): Promise<boolean> {
  const m = (await run('ps', ['eww', '-o', 'ppid=,command=', '-p', String(pid)])).match(
    /^\s*(\d+)\s+([\s\S]*)$/
  )
  if (!m || Number(m[1]) !== ADOPTED_BY_LAUNCHD || sessionOf(m[2]) !== sessionId) return false
  try {
    kill(pid)
    return true
  } catch {
    return false
  }
}
