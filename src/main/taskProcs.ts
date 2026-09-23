import { execFile } from 'child_process'
import path from 'path'

/**
 * What Claude Code's background SHELLS are doing right now, read off the OS.
 *
 * A background shell (Bash `run_in_background`, a timed-out command moved to the
 * background, a Ctrl+B-parked one, a Monitor) is a child process of claude —
 * `/bin/zsh -c source …/shell-snapshots/… && eval '…'` — whose stdout is the task's
 * own `<scratch>/tasks/<id>.output` file. Measured on claude 2.1.261 (lsof shows
 * fd 1 and 2 of the zsh and of every descendant pointing at that file); the file
 * itself outlives the task, the open descriptor does not. So "is task <id> still
 * running" has an exact answer — a tool shell holding its output file — instead
 * of the guess the transcript allows (a shell writes no transcript at all).
 *
 * A FOREGROUND Bash call looks exactly the same — its stdout is a task output file
 * too (measured on 2.1.261, docs/claude-code-contract.md §8), just one the Stop
 * list does not name. The caller, which has that list, is what tells a foreground
 * call in flight — some agent inside a tool call this instant, the one kind of
 * liveness a long silent tool call gives no transcript evidence of — from a
 * background task.
 *
 * Whether a background shell is a dev server rather than a long test is answered
 * two ways, cheapest first: it (or a descendant) LISTENS on a TCP port, or it has
 * simply been running longer than any test reasonably does (the caller's call —
 * `ageMs` is reported, not judged here). A `bun listen.ts` was found 11.5h into
 * its run with no listening socket, so age is not optional.
 *
 * One `ps -A` snapshot plus at most two `lsof` calls per inspection; the caller
 * throttles. `null` means "could not tell" (ps failed, the root is not a claude)
 * and must be read as unknown, never as "nothing is running".
 */

export interface ShellProc {
  pid: number
  /** how long the task's shell has been running */
  ageMs: number
  /** the shell or a descendant holds a listening TCP socket — a server */
  listening: boolean
}

export interface TaskProcs {
  /** task id (basename of the `tasks/<id>.output` a tool shell's stdout points
   *  at) → its live shell; foreground calls included — the Stop list tells which */
  shells: Map<string, ShellProc>
}

/** Runs a command and resolves with whatever it printed, even on a non-zero exit
 *  (lsof exits 1 whenever one of the asked-for pids has nothing to show). An empty
 *  string is the failure signal. Injectable for tests. */
export type Exec = (cmd: string, args: string[]) => Promise<string>

/** The exec behind the inspection, with the deadline as a parameter so a test can
 *  drive the cut-short path with a real process. A run that was KILLED (deadline,
 *  signal) may have printed part of its listing — a partial view read as complete
 *  would say "ended" of everything past the cut, so it answers nothing at all,
 *  which the callers read as unknown. */
export function makeExec(timeoutMs: number): Exec {
  return (cmd, args) =>
    new Promise((resolve) => {
      execFile(cmd, args, { maxBuffer: 8 * 1024 * 1024, timeout: timeoutMs }, (err, stdout) => {
        if (err && (err.killed || err.signal)) return resolve('')
        resolve(typeof stdout === 'string' ? stdout : '')
      })
    })
}

const defaultExec: Exec = makeExec(5000)

/** claude runs every Bash tool call as `<shell> -c source …/shell-snapshots/… &&
 *  eval '…'`; the snapshot path is the reliable tell, the `eval` the fallback
 *  for a shell claude did not snapshot. NOT a bare `-c`: hooks (this app's own
 *  Stop hook included — it has just posted the report that triggers the
 *  inspection) and statusline commands are `sh -c <command>` children too, and
 *  one caught in flight would read as a tool call and hold the dot a tick. */
function isToolShell(command: string): boolean {
  return /shell-snapshots/.test(command) || /(^|\/)(zsh|bash|sh) -c .*\beval\b/.test(command)
}

/** `ps` etime: `[[dd-]hh:]mm:ss` → ms */
export function parseEtime(s: string): number {
  const m = s.trim().match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/)
  if (!m) return 0
  const days = Number(m[1] ?? 0)
  const hours = Number(m[2] ?? 0)
  return (((days * 24 + hours) * 60 + Number(m[3])) * 60 + Number(m[4])) * 1000
}

interface Snapshot {
  childrenOf: Map<number, number[]>
  commandOf: Map<number, string>
  etimeOf: Map<number, string>
}

function parsePs(stdout: string): Snapshot | null {
  const childrenOf = new Map<number, number[]>()
  const commandOf = new Map<number, string>()
  const etimeOf = new Map<number, string>()
  for (const line of stdout.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/)
    if (!m) continue
    const pid = Number(m[1])
    const ppid = Number(m[2])
    commandOf.set(pid, m[4])
    etimeOf.set(pid, m[3])
    const kids = childrenOf.get(ppid)
    if (kids) kids.push(pid)
    else childrenOf.set(ppid, [pid])
  }
  return commandOf.size ? { childrenOf, commandOf, etimeOf } : null
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

/** `lsof -F` output is one field per line: `p<pid>` opens a process block, then
 *  `f<fd>` / `n<name>` pairs. Returns pid → fd-1 name. */
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

/**
 * Inspect the tool shells of the claude at `rootPid` (the tab's pty process — a
 * session pty runs `exec claude`). `tasksDir` is the session's `<scratch>/tasks`
 * dir (see scratchpadDirFor).
 */
export async function inspectTaskProcs(
  rootPid: number,
  tasksDir: string,
  exec: Exec = defaultExec
): Promise<TaskProcs | null> {
  const snap = parsePs(await exec('ps', ['-Ao', 'pid=,ppid=,etime=,command=']))
  if (!snap) return null
  // not a claude (gone, or not the process shape this walk was written for):
  // unknown — an empty view here would read as "every shell ended"
  if (!/claude/i.test(snap.commandOf.get(rootPid) ?? '')) return null
  const shells = (snap.childrenOf.get(rootPid) ?? []).filter((k) =>
    isToolShell(snap.commandOf.get(k) ?? '')
  )
  const result: TaskProcs = { shells: new Map() }
  if (!shells.length) return result
  const fd1 = await exec('lsof', ['-a', '-p', shells.join(','), '-d', '1', '-Fn'])
  // Nothing printed for live shells means lsof failed (or timed out), not that
  // every one of them closed its stdout — a tool shell always has one. Answer
  // "unknown": read as "all ended" it would release every held turn-end.
  if (!fd1.trim()) return null
  const names = parseLsofNames(fd1)
  const prefix = path.resolve(tasksDir) + path.sep
  for (const pid of shells) {
    const name = names.get(pid)
    // fd 1 closed, lsof could not see it, or not an output file of this session
    if (name === undefined || !name.startsWith(prefix) || !name.endsWith('.output')) continue
    result.shells.set(path.basename(name, '.output'), {
      pid,
      ageMs: parseEtime(snap.etimeOf.get(pid) ?? ''),
      listening: false
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
