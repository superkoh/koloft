import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawn } from 'child_process'

vi.mock('node-pty', () => ({ spawn: vi.fn() }))

import { CLAUDE_AGENT_SHIM, REMOTE_AGENT_SHIM, writeAgentShim } from '../../src/main/agentShim'
import { CANNOT_WRITE_THE_REQUEST } from './helpers/agentShims'
import { AGENT_SHIM_WAITS_MS, answered, refused } from '../../src/core/command'
import { AgentRequests, replyJson, REQUEST_NAME } from '../../src/main/agentRequests'
import { passOf } from '../../src/main/tabPass'
import { testCommands } from './helpers/testCommands'
import { oncePerName, watchAndSweepJsonDrops, watchJsonDrops } from '../../src/main/jsonDrops'
import type { SessionInfo } from '../../src/shared/types'
import { agentGuide } from '../../src/shared/agentGuide'

const TAB = `pty-${process.pid.toString(36)}-1`
const AWKWARD = 'say "hi" to C:\\temp\\n\tand\n50% of 日本 ✓\n'

let base: string
let shimDir: string
let agentDir: string
let received: { argv: string[]; tabId: string }[]
let watcher: fs.FSWatcher | null

const commands = testCommands({
  echo: (args, caller) => {
    received.push({ argv: args, tabId: caller.tabId })
    return answered(args[0] ?? '')
  },
  fail: () => refused('it broke: "x"', 3),
  session: async () => {
    await new Promise((r) => setTimeout(r, AGENT_SHIM_WAITS_MS + 500))
    return answered('Answered Fix login.')
  }
})

const session = (tabId: string): SessionInfo => ({
  tabId,
  backendId: 'claude',
  host: 'local',
  sessionId: 's1',
  title: 'Fix login',
  cwd: '/w',
  treeRoot: '/w',
  alive: true,
  updatedAt: 1
})

function listen(dir: string): void {
  watcher = new AgentRequests({
    commands,
    tab: () => ({ util: false }),
    session,
    enabled: () => true,
    alive: () => true
  }).watch(dir)
}

function run(
  script: string,
  args: string[],
  env: Record<string, string>
): Promise<{ status: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(script, args, {
      cwd: base,
      env: { PATH: '/usr/bin:/bin', PWD: base, ...env }
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (c) => (stdout += c))
    child.stderr.on('data', (c) => (stderr += c))
    child.on('close', (status) => resolve({ status: status ?? -1, stdout, stderr }))
  })
}

beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-agent-shim-')))
  shimDir = path.join(base, 'shim')
  agentDir = path.join(base, 'agent')
  fs.mkdirSync(shimDir)
  fs.mkdirSync(agentDir)
  fs.writeFileSync(path.join(shimDir, 'koloft'), CLAUDE_AGENT_SHIM, { mode: 0o755 })
  received = []
  watcher = null
})

afterEach(() => {
  watcher?.close()
  fs.rmSync(base, { recursive: true, force: true })
})

const claudeEnv = (): Record<string, string> => ({
  KOLOFT_AGENT_DIR: agentDir,
  KOLOFT_TAB_ID: TAB,
  KOLOFT_TAB_PASS: passOf(TAB),
  KOLOFT_PID: String(process.pid)
})

describe('koloft command in a Claude session', () => {
  it('carries every argument to Koloft byte for byte and prints the answer byte for byte', async () => {
    listen(agentDir)
    const r = await run(path.join(shimDir, 'koloft'), ['echo', AWKWARD, ''], claudeEnv())
    expect(received).toEqual([{ argv: [AWKWARD, ''], tabId: TAB }])
    expect(r.stdout).toBe(`${AWKWARD}\n`)
    expect(r.status).toBe(0)
    expect(fs.readdirSync(agentDir)).toEqual([])
  })

  it('koloft session answer waits past the usual wait, while Koloft watches the session take the answer', async () => {
    listen(agentDir)
    const r = await run(
      path.join(shimDir, 'koloft'),
      ['session', 'answer', 'x', 'yes'],
      claudeEnv()
    )
    expect(r.stdout).toBe('Answered Fix login.\n')
    expect(r.status).toBe(0)
  }, 30_000)

  it('prints a refusal on stderr and exits with the code Koloft gave', async () => {
    listen(agentDir)
    const r = await run(path.join(shimDir, 'koloft'), ['fail'], claudeEnv())
    expect(r.stdout).toBe('')
    expect(r.stderr).toBe('it broke: "x"\n')
    expect(r.status).toBe(3)
  })

  it('an answer for a koloft command that already went away is never written, so a secret meant for it does not stay on disk', async () => {
    const requests = new AgentRequests({
      commands,
      tab: () => ({ util: false }),
      session,
      enabled: () => true,
      alive: (pid) => pid !== 4242
    })
    await requests.answer(agentDir, 'req-gone.json', {
      tabId: TAB,
      pass: passOf(TAB),
      argv: ['echo', 'hunter2'],
      cwd: base,
      pid: 4242
    })
    await requests.answer(agentDir, 'req-here.json', {
      tabId: TAB,
      pass: passOf(TAB),
      argv: ['echo', 'hi'],
      cwd: base,
      pid: 4243
    })
    expect(fs.readdirSync(agentDir)).toEqual(['res-here.json'])
  })

  it('outside a live Koloft session it says so and exits 1 without writing a request', async () => {
    const r = await run(path.join(shimDir, 'koloft'), ['help'], {
      ...claudeEnv(),
      KOLOFT_AGENT_DIR: ''
    })
    expect(r.status).toBe(1)
    expect(r.stderr).toMatch(/^koloft: /)
    expect(fs.readdirSync(agentDir)).toEqual([])
  })
})

describe('koloft command in a Claude session on a remote machine', () => {
  function answerEveryRequest(hookDir: string, raws: unknown[]): void {
    watcher = watchAndSweepJsonDrops(
      hookDir,
      oncePerName((name) => {
        const id = REQUEST_NAME.exec(name)?.[1]
        return id
          ? (raw): void => {
              raws.push(raw)
              fs.writeFileSync(path.join(hookDir, `res-${id}.json`), replyJson(answered('hi')))
              fs.rmSync(path.join(hookDir, name))
            }
          : null
      })
    )
  }

  function runOnTheMachine(
    sessionEnvOfMine: string,
    env: Record<string, string>
  ): Promise<{ status: number; stdout: string; raws: unknown[]; hookDir: string }> {
    const hookDir = path.join(base, '.koloft', 'hook-sessions')
    const remoteShim = path.join(base, 'machine-bin', 'koloft')
    fs.mkdirSync(path.dirname(remoteShim))
    fs.writeFileSync(remoteShim, REMOTE_AGENT_SHIM, { mode: 0o755 })
    fs.writeFileSync(
      path.join(shimDir, 'tmux'),
      `#!/bin/sh
case "$1" in
  list-panes) printf '%s k-mine\\n99999 k-other\\n' ${process.pid} ;;
  display-message) if [ "$4" = %3 ]; then echo k-other; else echo k-mine; fi ;;
  show-environment) [ "$3" = k-mine ] && printf '%b' "${sessionEnvOfMine}" | grep "^$4="; [ "$3" = k-other ] && echo "$4=other-$4" ;;
esac
exit 0
`,
      { mode: 0o755 }
    )
    fs.mkdirSync(hookDir, { recursive: true })
    const raws: unknown[] = []
    answerEveryRequest(hookDir, raws)
    return run(remoteShim, ['echo', 'hi'], {
      HOME: base,
      PATH: `${shimDir}:/usr/bin:/bin`,
      KOLOFT_TAB_ID: TAB,
      TMUX: '/tmp/tmux-1/koloft,1,0',
      TMUX_PANE: '%0',
      ...env
    }).then((r) => ({ ...r, raws, hookDir }))
  }

  it('inside a tmux session whose own environment Koloft gave a tab id and pass, as it does when it attaches after a restart, sends those, not the ones the process started with', async () => {
    const r = await runOnTheMachine('KOLOFT_TAB_ID=now-id\\nKOLOFT_TAB_PASS=now-pass\\n', {
      KOLOFT_TAB_PASS: 'from-the-start'
    })
    expect(r.stdout).toBe('hi\n')
    expect(r.raws).toEqual([
      expect.objectContaining({ tabId: 'now-id', pass: 'now-pass', tmux: 'k-mine' })
    ])
  })

  it('finds its tmux session by the processes it runs under, so a TMUX_PANE naming another tab’s pane does not hand it that tab’s pass', async () => {
    const r = await runOnTheMachine('', { KOLOFT_TAB_PASS: 'mine', TMUX_PANE: '%3' })
    expect(r.raws).toEqual([expect.objectContaining({ tabId: TAB, pass: 'mine', tmux: 'k-mine' })])
  })

  it('writes its request, naming its tab, its pass and its tmux session, into the folder the mirror brings back, and prints the answer Koloft writes beside it', async () => {
    const { raws, hookDir, ...r } = await runOnTheMachine('', { KOLOFT_TAB_PASS: 'p1' })
    expect(r.stdout).toBe('hi\n')
    expect(raws).toEqual([
      {
        tabId: TAB,
        tmux: 'k-mine',
        pass: 'p1',
        argv: ['echo', 'hi'],
        cwd: base,
        pid: expect.any(Number)
      }
    ])
    expect(fs.readdirSync(hookDir)).toEqual([])
  })

  it('killed while it waits, it takes its request back, so no answer is ever written for nobody', async () => {
    const hookDir = path.join(base, '.koloft', 'hook-sessions')
    const remoteShim = path.join(base, 'machine-bin', 'koloft')
    fs.mkdirSync(path.dirname(remoteShim))
    fs.mkdirSync(hookDir, { recursive: true })
    fs.writeFileSync(remoteShim, REMOTE_AGENT_SHIM, { mode: 0o755 })
    const child = spawn(remoteShim, ['secret', 'sudo', 'Password:', 'x'], {
      env: { HOME: base, PATH: '/usr/bin:/bin', KOLOFT_TAB_ID: TAB }
    })
    const closed = new Promise((resolve) => child.on('close', resolve))
    while (!fs.readdirSync(hookDir).some((n) => REQUEST_NAME.test(n)))
      await new Promise((r) => setTimeout(r, 20))
    child.kill('SIGTERM')
    await closed
    expect(fs.readdirSync(hookDir)).toEqual([])
  })
})

describe('koloft command in a Codex session', () => {
  let requestDir: string

  beforeEach(() => {
    requestDir = path.join(base, 'codex-requests')
    fs.mkdirSync(requestDir)
    writeAgentShim(shimDir, requestDir, 'codex', CANNOT_WRITE_THE_REQUEST.codex)
  })

  afterEach(() => {
    fs.chmodSync(requestDir, 0o700)
    fs.rmSync(requestDir, { recursive: true, force: true })
  })

  it('names no tab, as its request folder is written into the script, and carries the pass the tab was given', async () => {
    const tab = new AgentRequests({
      commands,
      tab: () => undefined,
      session,
      enabled: () => true,
      alive: () => true
    })
    const raws: unknown[] = []
    watcher = watchJsonDrops(requestDir, (name) =>
      name.startsWith('req-')
        ? (raw): void => {
            raws.push(raw)
            void tab.answerFor(TAB, requestDir, name, raw)
          }
        : null
    )
    const r = await run(path.join(shimDir, 'koloft'), ['echo', 'hi'], {
      KOLOFT_TAB_PASS: passOf(TAB)
    })
    expect(r.stdout).toBe('hi\n')
    expect(received).toEqual([{ argv: ['hi'], tabId: TAB }])
    expect(raws[0]).not.toHaveProperty('tabId')
  })

  it('in a read-only sandbox it still prints its guide', async () => {
    fs.chmodSync(requestDir, 0o555)
    for (const args of [['help'], [], ['--help']]) {
      const guide = await run(path.join(shimDir, 'koloft'), args, {})
      expect(guide.status).toBe(0)
      expect(guide.stdout).toBe(agentGuide() + '\n')
    }
  })

  it("prints the guide with its project's own rules for picking a model, quotes and $ kept as written", async () => {
    const rules = 'Code: "opus", high — not $HOME or `whoami`.'
    writeAgentShim(shimDir, requestDir, 'codex', CANNOT_WRITE_THE_REQUEST.codex, rules)
    const guide = await run(path.join(shimDir, 'koloft'), ['help'], {})
    expect(guide.stdout).toBe(agentGuide(rules) + '\n')
    expect(guide.stdout).toContain(rules)
  })
})

describe('koloft command in a Codex or Antigravity session says which agent it runs in, and what stops it', () => {
  it.each([
    ['codex', 'Codex'],
    ['agy', 'Antigravity']
  ] as const)(
    'once Koloft lets go of it, a %s session says it is a %s session no longer linked to Koloft, and exits 1',
    async (backend, label) => {
      writeAgentShim(
        shimDir,
        path.join(base, `${backend}-requests`),
        backend,
        CANNOT_WRITE_THE_REQUEST[backend]
      )
      const r = await run(path.join(shimDir, 'koloft'), ['note'], {})
      expect(r.status).toBe(1)
      expect(r.stderr).toBe(`koloft: this ${label} session is no longer linked to Koloft.\n`)
    }
  )

  it.each([
    ['codex', 'koloft: this sandbox is read-only, so koloft cannot run here.'],
    ['agy', 'koloft: could not reach Koloft.']
  ] as const)(
    'a %s session that cannot write its request prints only "%s", and exits 1',
    async (backend, said) => {
      const requestDir = path.join(base, `${backend}-requests`)
      fs.mkdirSync(requestDir, { mode: 0o555 })
      writeAgentShim(shimDir, requestDir, backend, CANNOT_WRITE_THE_REQUEST[backend])
      try {
        const r = await run(path.join(shimDir, 'koloft'), ['note'], {})
        expect(r.status).toBe(1)
        expect(r.stderr).toBe(`${said}\n`)
      } finally {
        fs.chmodSync(requestDir, 0o700)
      }
    }
  )
})
