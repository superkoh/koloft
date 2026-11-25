import fs from 'fs'
import os from 'os'
import path from 'path'
import type { LeftoverProcess } from '@shared/types'
import { makeExec, type Exec } from './taskProcs'
import type { ProcessTable } from './processTable'

const SCAN_DEADLINE_MS = 5000
const defaultExec = makeExec(SCAN_DEADLINE_MS)

const ADOPTED_BY_LAUNCHD = 1

const idIn = (commandWithEnv: string, name: string): string | undefined =>
  commandWithEnv.match(new RegExp(`(?:^|\\s)${name}=([0-9a-f-]{36})(?=\\s|$)`, 'm'))?.[1]

// CC§9
function sessionOf(commandWithEnv: string): string | undefined {
  return idIn(commandWithEnv, 'CLAUDE_CODE_SESSION_ID')
}

export function orphansByLaunchd(table: ProcessTable | null): Map<number, string> {
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

// PLATFORM§3
export const CODEX_TMP_DIR = process.platform === 'darwin' ? '/tmp' : os.tmpdir()
export const MACOS_PID_AT_MOST_FIVE_DIGITS = '\\d{1,5}'
const OPEN_SHIM_TOKEN = `(${MACOS_PID_AT_MOST_FIVE_DIGITS})-[0-9a-f-]{36}$`
export const OPEN_SHIM_FOLDER = new RegExp(`^${OPEN_SHIM_TOKEN}`)
export const OPEN_REQUEST_FOLDER = new RegExp(`^koloft-cx-open-${OPEN_SHIM_TOKEN}`)

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
