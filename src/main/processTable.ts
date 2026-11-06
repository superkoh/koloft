import { execFile } from 'child_process'

export interface ProcessRow {
  pid: number
  ppid: number
  pgid: number
  state: string
  ageMs: number
  cpuMs: number
  started: string
  command: string
}

export interface ProcessTable {
  at: number
  rows: ProcessRow[]
  byPid: Map<number, ProcessRow>
  childrenOf: Map<number, number[]>
}

export interface ProcessTables {
  fresh(): Promise<ProcessTable | null>
  eachRound(periodMs: number): Promise<ProcessTable | null>
}

const PS_COLUMNS = 'pid=,ppid=,pgid=,stat=,etime=,time=,lstart=,command='
const PS_DEADLINE_MS = 5000

export function parsePsDuration(s: string): number {
  const m = s.trim().match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/)
  if (!m) return 0
  const hours = Number(m[1] ?? 0) * 24 + Number(m[2] ?? 0)
  return Math.round(((hours * 60 + Number(m[3])) * 60 + Number(m[4])) * 1000)
}

// PLATFORM§3
const ROW =
  /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\w{3}\s+\w{3}\s+\d{1,2}\s+\d\d:\d\d:\d\d\s+\d{4})\s+(.*)$/

export function parseProcessTable(stdout: string, at: number): ProcessTable | null {
  const rows: ProcessRow[] = []
  const byPid = new Map<number, ProcessRow>()
  const childrenOf = new Map<number, number[]>()
  for (const line of stdout.split('\n')) {
    const m = ROW.exec(line)
    if (!m) continue
    const row: ProcessRow = {
      pid: Number(m[1]),
      ppid: Number(m[2]),
      pgid: Number(m[3]),
      state: m[4],
      ageMs: parsePsDuration(m[5]),
      cpuMs: parsePsDuration(m[6]),
      started: m[7].replace(/\s+/g, ' '),
      command: m[8]
    }
    rows.push(row)
    byPid.set(row.pid, row)
    const kids = childrenOf.get(row.ppid)
    if (kids) kids.push(row.pid)
    else childrenOf.set(row.ppid, [row.pid])
  }
  return rows.length ? { at, rows, byPid, childrenOf } : null
}

export function descendants(table: ProcessTable, root: number): number[] {
  const out: number[] = []
  const stack = [root]
  const seen = new Set<number>()
  while (stack.length) {
    const pid = stack.pop() as number
    if (seen.has(pid)) continue
    seen.add(pid)
    out.push(pid)
    const kids = table.childrenOf.get(pid)
    if (kids) stack.push(...kids)
  }
  return out
}

// PLATFORM§3
function psEnvironment(): NodeJS.ProcessEnv {
  const { LC_ALL, ...env } = process.env
  return { ...env, LC_CTYPE: LC_ALL ?? env.LC_CTYPE, LC_TIME: 'C', TZ: 'UTC' }
}

function readPs(): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      'ps',
      ['-axo', PS_COLUMNS],
      { env: psEnvironment(), maxBuffer: 8 * 1024 * 1024, timeout: PS_DEADLINE_MS },
      (err, stdout) => resolve(err ? null : stdout)
    )
  })
}

const newEachRound = (periodMs: number): number => periodMs / 2

export function processTables(ps: () => Promise<string | null> = readPs): ProcessTables {
  let latest: ProcessTable | undefined
  let reading: Promise<ProcessTable | null> | undefined
  let readingNext: Promise<ProcessTable | null> | undefined
  const start = (): Promise<ProcessTable | null> => {
    const at = Date.now()
    reading = ps()
      .then((stdout) => {
        const table = stdout ? parseProcessTable(stdout, at) : null
        if (table) latest = table
        return table
      })
      .finally(() => {
        reading = undefined
      })
    return reading
  }
  const fresh = (): Promise<ProcessTable | null> => {
    if (!reading) return start()
    return (readingNext ??= reading.then(() => {
      readingNext = undefined
      return reading ?? start()
    }))
  }
  const recent = async (maxAgeMs: number): Promise<ProcessTable | null> =>
    latest && Date.now() - latest.at < maxAgeMs ? latest : (reading ?? start())
  return { fresh, eachRound: (periodMs) => recent(newEachRound(periodMs)) }
}

export const sharedProcessTable = processTables()
