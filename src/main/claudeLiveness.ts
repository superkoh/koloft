import { execFile } from 'child_process'

/**
 * Liveness probe used as a *fallback* for the SessionEnd hook. The hook reverts a
 * tab from a claude tab back to a plain terminal the instant claude exits in-TUI —
 * but it only fires on a graceful exit (`/exit`, Ctrl+D, logout). A hard exit
 * (Ctrl+C kill, crash, the process being signalled) leaves no SessionEnd, so the
 * tab would otherwise stay "claude" forever. Asking the OS whether a `claude`
 * process is still running under the tab's shell catches every exit path.
 *
 * Unix only — it mirrors the shim/hooks, which are bash and Unix-only anyway.
 */

/** Does a process's command look like the Claude Code CLI (a native `claude`
 *  binary, or `node …/claude-code/cli.js`)? Deliberately broad: a false "alive"
 *  only *delays* the fallback (the hook is the fast path), whereas a false "gone"
 *  would wrongly revert a *live* claude tab — so we always err toward alive. A
 *  process's cwd is NOT part of its ps command string, so a `.claude/…` working
 *  dir can't trip this match. */
function looksLikeClaude(command: string): boolean {
  return /claude/i.test(command)
}

/**
 * Given a set of pty root pids (one per bound claude tab), return the subset that
 * still has a running `claude` in its process tree, root included. A single
 * `ps` snapshot covers every root. Resolves to `null` on any failure (`ps` error,
 * empty output, maxBuffer overflow) so the caller can tell "probe failed, state
 * unknown" from "probe ran, no claude found" and skip the round — a transient `ps`
 * failure must never be read as "claude gone" and trigger an untrack.
 */
export function rootsWithClaude(rootPids: number[]): Promise<Set<number> | null> {
  return new Promise((resolve) => {
    if (!rootPids.length) return resolve(new Set())
    execFile(
      'ps',
      ['-Ao', 'pid=,ppid=,command='],
      { maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => {
        if (err || !stdout) return resolve(null)
        const childrenOf = new Map<number, number[]>()
        const commandOf = new Map<number, string>()
        for (const line of stdout.split('\n')) {
          const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/)
          if (!m) continue
          const pid = Number(m[1])
          const ppid = Number(m[2])
          commandOf.set(pid, m[3])
          const kids = childrenOf.get(ppid)
          if (kids) kids.push(pid)
          else childrenOf.set(ppid, [pid])
        }
        // `ps -A` always lists many processes; parsing zero means the output format
        // didn't match our regex (a locale/variant we don't expect) — treat that as
        // a failed probe (null), never as "no claude alive", which would untrack
        // every live claude tab within two sweeps.
        if (!commandOf.size) return resolve(null)
        const alive = new Set<number>()
        for (const root of rootPids) {
          // the root ITSELF counts: a session pty runs `exec claude`, so claude is the
          // pty's own process, not a child of a shell (agent-centric §9). A legacy
          // shell tab still has it further down, hence the walk.
          const stack = [root]
          const seen = new Set<number>()
          while (stack.length) {
            const pid = stack.pop() as number
            if (seen.has(pid)) continue
            seen.add(pid)
            if (looksLikeClaude(commandOf.get(pid) ?? '')) {
              alive.add(root)
              break
            }
            const kids = childrenOf.get(pid)
            if (kids) stack.push(...kids)
          }
        }
        resolve(alive)
      }
    )
  })
}
