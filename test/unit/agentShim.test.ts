import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawn } from 'child_process'

vi.mock('node-pty', () => ({ spawn: vi.fn() }))

import { CLAUDE_AGENT_SHIM, writeCodexAgentShim } from '../../src/main/agentShim'
import { AgentRequests, answered, refused, type AgentVerbs } from '../../src/main/agentRequests'
import { watchJsonDrops } from '../../src/main/jsonDrops'

const TAB = `pty-${process.pid.toString(36)}-1`
const AWKWARD = 'say "hi" to C:\\temp\\n\tand\n50% of 日本 ✓\n'

let base: string
let shimDir: string
let agentDir: string
let received: { argv: string[]; tabId: string }[]
let watcher: fs.FSWatcher | null

const verbs: AgentVerbs = {
  echo: (args, caller) => {
    received.push({ argv: args, tabId: caller.tabId })
    return answered(args[0] ?? '')
  },
  fail: () => refused('it broke: "x"', 3)
}

function listen(dir: string): void {
  watcher = new AgentRequests({
    verbs,
    tab: () => ({ util: false }),
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

  it('prints a refusal on stderr and exits with the code Koloft gave', async () => {
    listen(agentDir)
    const r = await run(path.join(shimDir, 'koloft'), ['fail'], claudeEnv())
    expect(r.stdout).toBe('')
    expect(r.stderr).toBe('it broke: "x"\n')
    expect(r.status).toBe(3)
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

describe('koloft command in a Codex session', () => {
  let requestDir: string

  beforeEach(() => {
    requestDir = writeCodexAgentShim(shimDir, `test-${process.pid}-${Date.now()}`)
  })

  afterEach(() => {
    fs.chmodSync(requestDir, 0o700)
    fs.rmSync(requestDir, { recursive: true, force: true })
  })

  it('needs no Koloft variables: its request folder is written into the script', async () => {
    const tab = new AgentRequests({
      verbs,
      tab: () => undefined,
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
    const r = await run(path.join(shimDir, 'koloft'), ['echo', 'hi'], {})
    expect(r.stdout).toBe('hi\n')
    expect(received).toEqual([{ argv: ['hi'], tabId: TAB }])
    expect(raws[0]).not.toHaveProperty('tabId')
  })

  it('in a read-only sandbox it says it cannot run here and exits 1', async () => {
    fs.chmodSync(requestDir, 0o555)
    const r = await run(path.join(shimDir, 'koloft'), ['help'], {})
    expect(r.status).toBe(1)
    expect(r.stderr).toMatch(/read-only/)
  })
})
