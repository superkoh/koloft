import { execFile } from 'child_process'
import path from 'path'

export interface ShellProc {
  pid: number
  ageMs: number
  listening: boolean
  cpuMs: number
}

export interface TaskProcs {
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

export function parseEtime(s: string): number {
  const m = s.trim().match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/)
  if (!m) return 0
  const days = Number(m[1] ?? 0)
  const hours = Number(m[2] ?? 0)
  return (((days * 24 + hours) * 60 + Number(m[3])) * 60 + Number(m[4])) * 1000
}

export function parseCputime(s: string): number {
  const m = s.trim().match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/)
  if (!m) return 0
  const hours = Number(m[1] ?? 0) * 24 + Number(m[2] ?? 0)
  return Math.round(((hours * 60 + Number(m[3])) * 60 + Number(m[4])) * 1000)
}

interface Snapshot {
  childrenOf: Map<number, number[]>
  commandOf: Map<number, string>
  etimeOf: Map<number, string>
  cpuOf: Map<number, number>
}

function parsePs(stdout: string): Snapshot | null {
  const childrenOf = new Map<number, number[]>()
  const commandOf = new Map<number, string>()
  const etimeOf = new Map<number, string>()
  const cpuOf = new Map<number, number>()
  for (const line of stdout.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.*)$/)
    if (!m) continue
    const pid = Number(m[1])
    const ppid = Number(m[2])
    commandOf.set(pid, m[5])
    etimeOf.set(pid, m[3])
    cpuOf.set(pid, parseCputime(m[4]))
    const kids = childrenOf.get(ppid)
    if (kids) kids.push(pid)
    else childrenOf.set(ppid, [pid])
  }
  return commandOf.size ? { childrenOf, commandOf, etimeOf, cpuOf } : null
}

function descendants(snap: Snapshot, root: number): number[] {
  const out: number[] = []
  const stack = [root]
  const seen = new Set<number>()
  while (stack.length) {
    const pid = stack.pop() as number
    if (seen.has(pid)) continue
    seen.add(pid)
    out.push(pid)
    const kids = snap.childrenOf.get(pid)
    if (kids) stack.push(...kids)
  }
  return out
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

// CC§8
export async function inspectTaskProcs(
  rootPid: number,
  tasksDir: string,
  exec: Exec = defaultExec
): Promise<TaskProcs | null> {
  const snap = parsePs(await exec('ps', ['-Ao', 'pid=,ppid=,etime=,time=,command=']))
  if (!snap) return null
  if (!/claude/i.test(snap.commandOf.get(rootPid) ?? '')) return null
  const shells = (snap.childrenOf.get(rootPid) ?? []).filter((k) =>
    isToolShell(snap.commandOf.get(k) ?? '')
  )
  const result: TaskProcs = { shells: new Map() }
  if (!shells.length) return result
  const fd1 = await exec('lsof', ['-a', '-p', shells.join(','), '-d', '1', '-Fn'])
  if (!fd1.trim()) return null
  const names = parseLsofNames(fd1)
  const prefix = path.resolve(tasksDir) + path.sep
  for (const pid of shells) {
    const name = names.get(pid)
    if (name === undefined || !name.startsWith(prefix) || !name.endsWith('.output')) continue
    result.shells.set(path.basename(name, '.output'), {
      pid,
      ageMs: parseEtime(snap.etimeOf.get(pid) ?? ''),
      listening: false,
      cpuMs: descendants(snap, pid).reduce((sum, p) => sum + (snap.cpuOf.get(p) ?? 0), 0)
    })
  }
  if (result.shells.size) {
    const trees = new Map<string, number[]>()
    for (const [id, sh] of result.shells) trees.set(id, descendants(snap, sh.pid))
    const all = [...trees.values()].flat()
    const listening = parseLsofPids(
      await exec('lsof', ['-a', '-p', all.join(','), '-iTCP', '-sTCP:LISTEN', '-Fp'])
    )
    if (listening.size) {
      for (const [id, pids] of trees) {
        if (pids.some((p) => listening.has(p))) {
          const sh = result.shells.get(id)
          if (sh) sh.listening = true
        }
      }
    }
  }
  return result
}
