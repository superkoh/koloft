import { describe, it, expect } from 'vitest'
import { inspectTaskProcs, makeExec, parseEtime } from '../../src/main/taskProcs'

/*
 * The OS view of Claude Code's tool shells. `ps` / `lsof` are stubbed with the
 * exact output shapes measured on macOS (claude 2.1.261): every tool shell,
 * foreground or background, is a `zsh -c source …/shell-snapshots/…` child of
 * claude whose fd 1 is a `tasks/<id>.output`. See taskProcs.ts for what each
 * field is used for.
 */
const TASKS = '/tmp/claude-502/proj/sid/tasks'
const SNAP = '/Users/me/.claude/shell-snapshots/snapshot-zsh-1.sh'

const PS = [
  '    1     0 12-03:20:11 /sbin/launchd',
  ' 4242     1    01:02:03 /Users/me/.local/bin/claude --settings x.json',
  ' 4300  4242       05:00 /bin/zsh -c source ' + SNAP + ' && eval "sleep 100"',
  ' 4301  4300       05:00 sleep 100',
  ' 4400  4242 01-02:00:00 /bin/zsh -c source ' + SNAP + ' && eval "python3 -m http.server"',
  ' 4401  4400 01-02:00:00 python3 -m http.server 4179',
  ' 4500  4242       00:01 /bin/zsh -c source ' + SNAP + ' && eval "git status"',
  ' 4600  4242       00:03 node /Users/me/.ndot/ndot-mcp.mjs',
  ' 4700  4242       10:00 caffeinate -i -t 300',
  // a hook in flight: the app's own Stop hook, which posted the very report that
  // triggers this inspection — a `sh -c` child too, but no tool call
  ' 4800  4242       00:00 /bin/sh -c /x/hooks/sessionstart.sh /x/reg pty-1 stop'
].join('\n')

function stub(outputs: { ps?: string; fd1?: string; listen?: string }): {
  exec: (cmd: string, args: string[]) => Promise<string>
  calls: string[][]
} {
  const calls: string[][] = []
  return {
    calls,
    exec: async (cmd, args) => {
      calls.push([cmd, ...args])
      if (cmd === 'ps') return outputs.ps ?? PS
      if (args.includes('-d')) return outputs.fd1 ?? ''
      return outputs.listen ?? ''
    }
  }
}

describe('taskProcs', () => {
  it('parses ps etime in every shape it comes in', () => {
    expect(parseEtime('05:00')).toBe(5 * 60_000)
    expect(parseEtime('01:02:03')).toBe((3600 + 120 + 3) * 1000)
    expect(parseEtime('01-02:00:00')).toBe(26 * 3600 * 1000)
    expect(parseEtime('garbage')).toBe(0)
  })

  it('maps each tool shell to its task by the output file it holds, and reports a listening one', async () => {
    const s = stub({
      fd1: [
        'p4300',
        'f1',
        `n${TASKS}/bsleep.output`,
        'p4400',
        'f1',
        `n${TASKS}/bsrv.output`,
        'p4500',
        'f1',
        `n${TASKS}/bgit.output`
      ].join('\n'),
      listen: 'p4401\nf12\n'
    })
    const r = await inspectTaskProcs(4242, TASKS, s.exec)
    expect(r).not.toBeNull()
    expect([...r!.shells.keys()].sort()).toEqual(['bgit', 'bsleep', 'bsrv'])
    expect(r!.shells.get('bsleep')).toEqual({ pid: 4300, ageMs: 5 * 60_000, listening: false })
    // the listener is the shell's CHILD (python3), found through the tree
    expect(r!.shells.get('bsrv')).toEqual({ pid: 4400, ageMs: 26 * 3600_000, listening: true })
    // the foreground git call holds an output file too (§8), so it is on the map
    // like the rest — only the Stop list can say it is not a background task
    expect(r!.shells.get('bgit')?.pid).toBe(4500)
    // MCP servers, caffeinate and the hook `sh -c` are not tool shells and were
    // never asked about (a hook caught here would read as a tool call in flight)
    const fd1Call = s.calls.find((c) => c.includes('-d'))!
    expect(fd1Call[fd1Call.indexOf('-p') + 1]).toBe('4300,4400,4500')
  })

  it('answers null — unknown, never "nothing running" — when ps fails or the root is not a claude', async () => {
    expect(await inspectTaskProcs(4242, TASKS, stub({ ps: '' }).exec)).toBeNull()
    expect(await inspectTaskProcs(9999, TASKS, stub({}).exec)).toBeNull()
  })

  it('a run cut short by its deadline answers nothing, not the part it managed to print', async () => {
    // a real process: prints a line, then outlives a 150ms deadline. The partial
    // listing read as complete would say "ended" of everything past the cut
    const exec = makeExec(150)
    expect(await exec('sh', ['-c', 'echo partial; sleep 3'])).toBe('')
    // …while an ordinary non-zero exit (lsof's way of saying "one pid had
    // nothing") keeps what was printed
    expect(await exec('sh', ['-c', 'echo kept; exit 1'])).toBe('kept\n')
  })

  it('answers null when lsof prints nothing for live tool shells (it failed, they did not all close stdout)', async () => {
    // an empty view here would read as "every reported shell has ended" and
    // release every held turn-end — the false turn-done null exists to prevent
    expect(await inspectTaskProcs(4242, TASKS, stub({ fd1: '' }).exec)).toBeNull()
  })

  it('a claude with no tool shells is an empty view, with no lsof asked', async () => {
    const s = stub({ ps: ' 4242     1 01:00 /Users/me/.local/bin/claude\n' })
    const r = await inspectTaskProcs(4242, TASKS, s.exec)
    expect(r).toEqual({ shells: new Map() })
    expect(s.calls.map((c) => c[0])).toEqual(['ps'])
  })

  it('an output file outside the session tasks dir is not one of ours', async () => {
    const s = stub({ fd1: `p4300\nf1\nn/tmp/claude-502/other/sid/tasks/bx.output\n` })
    const r = await inspectTaskProcs(4242, TASKS, s.exec)
    expect(r!.shells.size).toBe(0)
  })
})
