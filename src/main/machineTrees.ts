import { execFile } from 'child_process'
import { psEnvironment } from './processTable'

export interface TaggedProcess {
  pid: number
  ppid: number
  rssBytes: number
  started: string
  agent: boolean
  tab?: string
}

// PLATFORM§3
const ROW = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d{1,2}\s+\d\d:\d\d:\d\d\s+\d{4})\s+(.*)$/
const TAB_TAG = /(?:^|\s)KOLOFT_TAB_ID=(\S+)/
export const AGENT_PROGRAM =
  /^(?:\S*\/)?(?:node\s+\S*\/(?:claude|codex|muse|agy)(?:\.js)?\s|node\s+\S*\/(?:claude-code|codex)\/\S*\s|(?:claude|codex|muse|agy)(?:\s|$))/
const PS_DEADLINE_MS = 5_000

export function parseTaggedTable(stdout: string): TaggedProcess[] {
  const out: TaggedProcess[] = []
  for (const line of stdout.split('\n')) {
    const m = ROW.exec(line)
    if (!m) continue
    const text = m[5]
    out.push({
      pid: Number(m[1]),
      ppid: Number(m[2]),
      rssBytes: Number(m[3]) * 1024,
      started: m[4].replace(/\s+/g, ' '),
      agent: AGENT_PROGRAM.test(text),
      tab: TAB_TAG.exec(text)?.[1]
    })
  }
  return out
}

// PLATFORM§59
export function treesByTab(rows: TaggedProcess[]): Map<string, TaggedProcess[]> {
  const kids = new Map<number, TaggedProcess[]>()
  for (const r of rows) {
    const list = kids.get(r.ppid)
    if (list) list.push(r)
    else kids.set(r.ppid, [r])
  }
  const members = new Map<string, TaggedProcess[]>()
  const owner = new Map<number, string>()
  for (const root of rows) {
    if (!root.tab || owner.has(root.pid)) continue
    const stack = [root]
    while (stack.length) {
      const p = stack.pop() as TaggedProcess
      if (owner.has(p.pid)) continue
      owner.set(p.pid, root.tab)
      const list = members.get(root.tab)
      if (list) list.push(p)
      else members.set(root.tab, [p])
      stack.push(...(kids.get(p.pid) ?? []).filter((k) => !k.tab || k.tab === root.tab))
    }
  }
  return members
}

// ADR-0042
export function toolsOf(members: TaggedProcess[], koloftPid: number): TaggedProcess[] {
  return members.filter((p) => !p.agent && p.ppid !== koloftPid)
}

export function withDescendants(rows: TaggedProcess[], roots: Set<number>): number[] {
  const kids = new Map<number, number[]>()
  for (const r of rows) {
    const list = kids.get(r.ppid)
    if (list) list.push(r.pid)
    else kids.set(r.ppid, [r.pid])
  }
  const out = new Set<number>()
  const stack = [...roots]
  while (stack.length) {
    const pid = stack.pop() as number
    if (out.has(pid)) continue
    out.add(pid)
    stack.push(...(kids.get(pid) ?? []))
  }
  return [...out]
}

export function readTaggedTable(): Promise<TaggedProcess[]> {
  return new Promise((resolve) => {
    execFile(
      'ps',
      ['-axEww', '-o', 'pid=,ppid=,rss=,lstart=,command='],
      { env: psEnvironment(), maxBuffer: 64 * 1024 * 1024, timeout: PS_DEADLINE_MS },
      (err, stdout) => resolve(err ? [] : parseTaggedTable(String(stdout)))
    )
  })
}

// PLATFORM§59
export function giveWay(pid: number, on: boolean): Promise<void> {
  return new Promise((resolve) => {
    execFile('/usr/sbin/taskpolicy', [on ? '-b' : '-B', '-p', String(pid)], () => resolve())
  })
}
