import { execFile } from 'child_process'

export interface TaggedProcess {
  pid: number
  ppid: number
  rssBytes: number
  cpuPercent: number
  agent: boolean
  tab?: string
  vm: boolean
}

const ROW = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+([\d.,]+)\s(.*)$/
const TAB_TAG = /(?:^|\s)KOLOFT_(?:TAB_ID|HOLD_TAB)=(\S+)/
const AGENT_PROGRAM =
  /^(?:\S*\/)?(?:node\s+\S*\/(?:claude|codex|muse|agy)(?:\.js)?\s|node\s+\S*\/(?:claude-code|codex)\/\S*\s|(?:claude|codex|muse|agy)(?:\s|$))/
// PLATFORM§59
const SHARED_VM = /com\.apple\.Virtualization\.VirtualMachine/
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
      cpuPercent: Number(m[4].replace(',', '.')),
      agent: AGENT_PROGRAM.test(text),
      tab: TAB_TAG.exec(text)?.[1],
      vm: SHARED_VM.test(text)
    })
  }
  return out
}

export interface Trees {
  members: Map<string, TaggedProcess[]>
  sharedVmBytes: number
}

// PLATFORM§59
export function treesByTab(rows: TaggedProcess[]): Trees {
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
  const sharedVmBytes = rows.filter((r) => r.vm).reduce((sum, r) => sum + r.rssBytes, 0)
  return { members, sharedVmBytes }
}

export function readTaggedTable(): Promise<TaggedProcess[]> {
  return new Promise((resolve) => {
    execFile(
      'ps',
      ['-axEww', '-o', 'pid=,ppid=,rss=,pcpu=,command='],
      { maxBuffer: 64 * 1024 * 1024, timeout: PS_DEADLINE_MS },
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
