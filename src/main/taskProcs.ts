import { execFile } from 'child_process'
import fs from 'fs'
import path from 'path'
import { descendants, type ProcessTable } from './processTable'
import { looksLikeClaude } from './claudeLiveness'

export interface ShellProc {
  pid: number
  ageMs: number
  listening: boolean
  cpuMsByPid: Map<number, number>
  outputBytes: number
}

export interface TaskProcs {
  at: number
  shells: Map<string, ShellProc>
}

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

const INSPECTION_DEADLINE_MS = 5000
const defaultExec: Exec = makeExec(INSPECTION_DEADLINE_MS)

// CC§8
function isToolShell(command: string): boolean {
  return /shell-snapshots/.test(command) || /(^|\/)(zsh|bash|sh) -c .*\beval\b/.test(command)
}

function parseLsofNames(stdout: string): Map<number, string> {
  const out = new Map<number, string>()
  let pid = 0
  for (const line of stdout.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1))
    else if (line.startsWith('n') && pid && !out.has(pid)) out.set(pid, line.slice(1))
  }
  return out
}

function parseLsofPids(stdout: string): Set<number> {
  const out = new Set<number>()
  for (const line of stdout.split('\n')) if (line.startsWith('p')) out.add(Number(line.slice(1)))
  return out
}

async function listeningPids(pids: number[], exec: Exec): Promise<Set<number>> {
  if (!pids.length) return new Set()
  return parseLsofPids(
    await exec('lsof', ['-a', '-p', pids.join(','), '-iTCP', '-sTCP:LISTEN', '-Fp'])
  )
}

// MUSE§8
function runsCommand(line: string, command: string): boolean {
  if (line === command || line.endsWith(` ${command}`)) return true
  const [program, ...args] = command.split(' ')
  const [binary, ...lineArgs] = line.split(' ')
  return (
    args.length > 0 &&
    args.join(' ') === lineArgs.join(' ') &&
    program.toLowerCase().startsWith(path.basename(binary).toLowerCase())
  )
}

// MUSE§8
export async function museServersAmong(
  table: ProcessTable | null,
  rootPid: number,
  commands: Map<string, string>,
  exec: Exec = defaultExec
): Promise<Set<string>> {
  if (!table) return new Set()
  const trees = new Map<string, number[]>()
  for (const child of table.childrenOf.get(rootPid) ?? []) {
    const line = table.byPid.get(child)?.command ?? ''
    for (const [id, command] of commands)
      if (runsCommand(line, command)) trees.set(id, descendants(table, child))
  }
  const listening = await listeningPids([...trees.values()].flat(), exec)
  return new Set(
    [...trees].filter(([, pids]) => pids.some((p) => listening.has(p))).map(([id]) => id)
  )
}

interface ClaudeShells {
  outputOf: Map<number, string>
  listening: Set<number>
}

const claudeShellsOf = new WeakMap<ProcessTable, Promise<ClaudeShells | null>>()

function toolShellsUnder(table: ProcessTable, pid: number): number[] {
  return (table.childrenOf.get(pid) ?? []).filter((k) =>
    isToolShell(table.byPid.get(k)?.command ?? '')
  )
}

// CC§8
async function readClaudeShells(table: ProcessTable, exec: Exec): Promise<ClaudeShells | null> {
  const shells = table.rows
    .filter((row) => looksLikeClaude(row.command))
    .flatMap((row) => toolShellsUnder(table, row.pid))
  const [fd1, listening] = await Promise.all([
    exec('lsof', ['-a', '-p', shells.join(','), '-d', '1', '-Fn']),
    listeningPids(
      shells.flatMap((pid) => descendants(table, pid)),
      exec
    )
  ])
  if (!fd1.trim()) return null
  const outputOf = new Map([...parseLsofNames(fd1)].filter(([, name]) => name.endsWith('.output')))
  return { outputOf, listening }
}

// CC§2 CC§8
export async function inspectTaskProcs(
  table: ProcessTable | null,
  rootPid: number,
  sessionId: string,
  exec: Exec = defaultExec
): Promise<TaskProcs | null> {
  if (!table) return null
  if (!looksLikeClaude(table.byPid.get(rootPid)?.command ?? '')) return null
  const result: TaskProcs = { at: table.at, shells: new Map() }
  const shells = toolShellsUnder(table, rootPid)
  if (!shells.length) return result
  let read = claudeShellsOf.get(table)
  if (!read) claudeShellsOf.set(table, (read = readClaudeShells(table, exec)))
  const seen = await read
  if (!seen) return null
  const sessionTasks = path.sep + path.join(sessionId, 'tasks')
  const found = await Promise.all(
    shells.map(async (pid): Promise<[string, ShellProc] | null> => {
      const name = seen.outputOf.get(pid)
      if (name === undefined || !path.dirname(name).endsWith(sessionTasks)) return null
      const tree = descendants(table, pid)
      return [
        path.basename(name, '.output'),
        {
          pid,
          ageMs: table.byPid.get(pid)?.ageMs ?? 0,
          listening: tree.some((p) => seen.listening.has(p)),
          cpuMsByPid: new Map(tree.map((p) => [p, table.byPid.get(p)?.cpuMs ?? 0])),
          outputBytes: await fs.promises.stat(name).then(
            (st) => st.size,
            () => 0
          )
        }
      ]
    })
  )
  for (const entry of found) if (entry) result.shells.set(...entry)
  return result
}
