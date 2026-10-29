import fs from 'fs'
import os from 'os'
import path from 'path'
import type { LeftoverProcess } from '@shared/types'
import { makeExec, type Exec } from './taskProcs'
import { sharedProcessTable, type ProcessTable } from './processTable'
import { museSessionKey, UUID } from './sessionStore'

const SCAN_DEADLINE_MS = 5000
const defaultExec = makeExec(SCAN_DEADLINE_MS)

const ADOPTED_BY_LAUNCHD = 1

const idIn = (commandWithEnv: string, name: string): string | undefined =>
  commandWithEnv.match(new RegExp(`(?:^|\\s)${name}=([0-9a-f-]{36})(?=\\s|$)`, 'm'))?.[1]

// CC§9 MUSE§8
function sessionOf(commandWithEnv: string): string | undefined {
  const claude = idIn(commandWithEnv, 'CLAUDE_CODE_SESSION_ID')
  if (claude) return claude
  const muse = idIn(commandWithEnv, 'MUSE_SESSION_ID')
  return muse && UUID.test(muse) ? museSessionKey(muse) : undefined
}

function orphansByLaunchd(table: ProcessTable | null): Map<number, string> {
  return new Map(
    (table?.rows ?? [])
      .filter((row) => row.ppid === ADOPTED_BY_LAUNCHD)
      .map((row) => [row.pid, row.command])
  )
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
export async function endCodexAppServersLeftByACrash(marker: string): Promise<void> {
  const leftovers = [...orphansByLaunchd(await sharedProcessTable.fresh())]
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

// PLATFORM§3
export const CODEX_TMP_DIR = process.platform === 'darwin' ? '/tmp' : os.tmpdir()
const MACOS_PID_AT_MOST_FIVE_DIGITS = '\\d{1,5}'
export const CODEX_TMP_FOLDER = new RegExp(
  `^koloft-cx-(?:open-)?(${MACOS_PID_AT_MOST_FIVE_DIGITS})-`
)
export const OPEN_SHIM_FOLDER = new RegExp(`^(${MACOS_PID_AT_MOST_FIVE_DIGITS})-[0-9a-f-]{36}$`)

export const ownedByThisRun = (name: string): string => `${process.pid}-${name}`

export function removeFoldersLeftByEndedRuns(dir: string, ours: RegExp): void {
  let names: string[]
  try {
    names = fs.readdirSync(dir)
  } catch {
    return
  }
  for (const name of names) {
    const owner = ours.exec(name)?.[1]
    if (owner && !pidAlive(Number(owner)))
      fs.rmSync(path.join(dir, name), { recursive: true, force: true })
  }
}

// CC§9 PLATFORM§3
export async function scanLeftovers(
  table: ProcessTable | null,
  run: Exec = defaultExec
): Promise<Record<string, LeftoverProcess[]>> {
  const commandOf = orphansByLaunchd(table)
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
