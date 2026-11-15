import { describe, it, expect } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { inspectTaskProcs, makeExec } from '../../src/main/taskProcs'
import { parseProcessTable, parsePsDuration, type ProcessTable } from '../../src/main/processTable'

const SID = 'sid'
const TASKS = `/tmp/claude-502/proj/${SID}/tasks`
const SNAP = '/Users/me/.claude/shell-snapshots/snapshot-zsh-1.sh'

const OWN_STOP_HOOK_IN_FLIGHT =
  ' 4800  4242       00:00 0:00.00 /bin/sh -c /x/hooks/sessionstart.sh /x/reg pty-1 stop'

// CC§8
const PS = [
  '    1     0 12-03:20:11 0:00.00 /sbin/launchd',
  ' 4242     1    01:02:03 0:00.00 /Users/me/.local/bin/claude --settings x.json',
  ' 4300  4242       05:00 0:00.05 /bin/zsh -c source ' + SNAP + ' && eval "sleep 100"',
  ' 4301  4300       05:00 0:01.50 sleep 100',
  ' 4400  4242 01-02:00:00 0:00.10 /bin/zsh -c source ' +
    SNAP +
    ' && eval "python3 -m http.server"',
  ' 4401  4400 01-02:00:00 0:02.40 python3 -m http.server 4179',
  ' 4500  4242       00:01 0:00.00 /bin/zsh -c source ' + SNAP + ' && eval "git status"',
  ' 4600  4242       00:03 0:00.00 node /Users/me/.ndot/ndot-mcp.mjs',
  ' 4700  4242       10:00 0:00.00 caffeinate -i -t 300',
  OWN_STOP_HOOK_IN_FLIGHT
].join('\n')

const STARTED = 'Sat Oct 17 01:29:13 2026'

function tableOf(ps: string): ProcessTable | null {
  const rows = ps
    .split('\n')
    .map((line) => line.replace(/^(\s*\d+\s+\d+)(\s+\S+\s+\S+)/, `$1 0 S$2 ${STARTED}`))
  return parseProcessTable(rows.join('\n'), 0)
}

function stub(outputs: { ps?: string; fd1?: string; listen?: string }): {
  table: ProcessTable | null
  exec: (cmd: string, args: string[]) => Promise<string>
  calls: string[][]
} {
  const calls: string[][] = []
  return {
    table: tableOf(outputs.ps ?? PS),
    calls,
    exec: async (cmd, args) => {
      calls.push([cmd, ...args])
      if (args.includes('-d')) return outputs.fd1 ?? ''
      return outputs.listen ?? ''
    }
  }
}

const inspect = (s: ReturnType<typeof stub>, root = 4242): ReturnType<typeof inspectTaskProcs> =>
  inspectTaskProcs(s.table, root, SID, s.exec)

describe('taskProcs', () => {
  it('parses ps etime in every shape it comes in', () => {
    expect(parsePsDuration('05:00')).toBe(5 * 60_000)
    expect(parsePsDuration('01:02:03')).toBe((3600 + 120 + 3) * 1000)
    expect(parsePsDuration('01-02:00:00')).toBe(26 * 3600 * 1000)
    expect(parsePsDuration('garbage')).toBe(0)
  })

  it('parses ps cpu time in every shape it comes in (minutes run past 59)', () => {
    expect(parsePsDuration('0:02.96')).toBe(2960)
    expect(parsePsDuration('1659:13.75')).toBe((1659 * 60 + 13.75) * 1000)
    expect(parsePsDuration('01:02:03')).toBe((3600 + 120 + 3) * 1000)
    expect(parsePsDuration('1-00:00:01')).toBe((24 * 3600 + 1) * 1000)
    expect(parsePsDuration('garbage')).toBe(0)
  })

  it('maps each tool shell, foreground ones too, to its task by the output file it holds, reports one whose child listens and the CPU of each program under it, and never asks lsof about MCP servers or hooks', async () => {
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
    const r = await inspect(s)
    expect(r).not.toBeNull()
    expect([...r!.shells.keys()].sort()).toEqual(['bgit', 'bsleep', 'bsrv'])
    expect(r!.shells.get('bsleep')).toEqual({
      pid: 4300,
      ageMs: 5 * 60_000,
      listening: false,
      cpuMsByPid: new Map([
        [4300, 50],
        [4301, 1500]
      ]),
      outputBytes: 0
    })
    expect(r!.shells.get('bsrv')).toEqual({
      pid: 4400,
      ageMs: 26 * 3600_000,
      listening: true,
      cpuMsByPid: new Map([
        [4400, 100],
        [4401, 2400]
      ]),
      outputBytes: 0
    })
    expect(r!.shells.get('bgit')?.pid).toBe(4500)
    const fd1Call = s.calls.find((c) => c.includes('-d'))!
    expect(fd1Call[fd1Call.indexOf('-p') + 1]).toBe('4300,4400,4500')
  })

  it('answers null — unknown, never "nothing running" — when ps fails or the root is not a claude', async () => {
    expect(await inspect(stub({ ps: '' }))).toBeNull()
    expect(await inspect(stub({}), 9999)).toBeNull()
  })

  it('a run cut short by its deadline answers nothing, not the part it managed to print, while a plain non-zero exit keeps its output', async () => {
    const exec = makeExec(150)
    expect(await exec('sh', ['-c', 'echo partial; sleep 3'])).toBe('')
    expect(await exec('sh', ['-c', 'echo kept; exit 1'])).toBe('kept\n')
  })

  it('answers null when lsof prints nothing for live tool shells (it failed, they did not all close stdout)', async () => {
    expect(await inspect(stub({ fd1: '' }))).toBeNull()
  })

  it('a claude with no tool shells is an empty view, with no lsof asked', async () => {
    const s = stub({ ps: ' 4242     1 01:00 0:00.00 /Users/me/.local/bin/claude\n' })
    const r = await inspect(s)
    expect(r).toEqual({ at: 0, shells: new Map() })
    expect(s.calls).toEqual([])
  })

  it('asks lsof once per process table for the tool shells of every claude in it, however many tabs read that table', async () => {
    const s = stub({
      ps: [
        PS,
        ' 5242     1    01:00:00 0:00.00 /Users/me/.local/bin/claude',
        ' 5300  5242       02:00 0:00.01 /bin/zsh -c source ' + SNAP + ' && eval "sleep 50"'
      ].join('\n'),
      fd1: [
        'p4300',
        'f1',
        `n${TASKS}/bsleep.output`,
        'p5300',
        'f1',
        `n/tmp/claude-502/proj/other/tasks/bnap.output`
      ].join('\n')
    })
    const [mine, theirs] = await Promise.all([
      inspect(s),
      inspectTaskProcs(s.table, 5242, 'other', s.exec)
    ])
    expect([...mine!.shells.keys()]).toEqual(['bsleep'])
    expect([...theirs!.shells.keys()]).toEqual(['bnap'])
    const fd1Calls = s.calls.filter((c) => c.includes('-d'))
    expect(fd1Calls).toHaveLength(1)
    expect(fd1Calls[0][fd1Calls[0].indexOf('-p') + 1].split(',').sort()).toEqual(
      ['4300', '4400', '4500', '5300'].sort()
    )
    expect(s.calls.filter((c) => c.includes('-sTCP:LISTEN'))).toHaveLength(1)
  })

  it('reports how much a shell has printed by the size of its output file', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taskprocs-'))
    const tasks = path.join(dir, SID, 'tasks')
    fs.mkdirSync(tasks, { recursive: true })
    fs.writeFileSync(path.join(tasks, 'bsleep.output'), '[1/9] first test\n')
    try {
      const r = await inspect(stub({ fd1: `p4300\nf1\nn${tasks}/bsleep.output\n` }))
      expect(r!.shells.get('bsleep')?.outputBytes).toBe(17)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('an output file in another session tasks dir is not one of ours', async () => {
    const s = stub({ fd1: `p4300\nf1\nn/tmp/claude-502/proj/other-sid/tasks/bx.output\n` })
    const r = await inspect(s)
    expect(r!.shells.size).toBe(0)
  })

  it('counts a shell under any folder slug, since -w and EnterWorktree sessions put tasks/ under different ones', async () => {
    const s = stub({
      fd1: [
        'p4300',
        'f1',
        `n/tmp/claude-502/proj/${SID}/tasks/bsleep.output`,
        'p4400',
        'f1',
        `n/tmp/claude-502/proj--claude-worktrees-w/${SID}/tasks/bsrv.output`
      ].join('\n')
    })
    const r = await inspect(s)
    expect([...r!.shells.keys()].sort()).toEqual(['bsleep', 'bsrv'])
  })
})
