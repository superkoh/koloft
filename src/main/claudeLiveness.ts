import { execFile } from 'child_process'

function looksLikeClaude(command: string): boolean {
  return /claude/i.test(command)
}

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
        if (!commandOf.size) return resolve(null)
        const alive = new Set<number>()
        for (const root of rootPids) {
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
