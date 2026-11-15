import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { execFileSync, spawn, type ChildProcess } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'

vi.mock('electron', async () => {
  const nfs = await import('node:fs')
  const nos = await import('node:os')
  const npath = await import('node:path')
  const base = nfs.mkdtempSync(npath.join(nos.tmpdir(), 'koloft-closed-tab-'))
  return { app: { getPath: () => base, getName: () => 'koloft-dev', isPackaged: false } }
})

const SID = '5d0e8f0c-0a51-4d1f-9a43-3a3c3f1f9b6e'
const TAB = 'pty-closed-1'
const OLD_CLAUDE_LEAVES_AFTER_MS = 300

let home: string
let ClaudeBackend: typeof import('../../src/main/backends/claude').ClaudeBackend
let OLD_CLAUDE_GOES_WITHIN_MS: number
const children: ChildProcess[] = []

beforeAll(async () => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-closed-tab-home-')))
  process.env.HOME = home
  ;({ ClaudeBackend } = await import('../../src/main/backends/claude'))
  ;({ OLD_CLAUDE_GOES_WITHIN_MS } = await import('../../src/main/claudeSessionRegistry'))
})

afterEach(() => {
  for (const child of children.splice(0)) child.kill('SIGKILL')
  fs.rmSync(path.join(home, '.claude'), { recursive: true, force: true })
})

function oldClaudeHolding(sessionId: string): ChildProcess {
  const child = spawn('/bin/sleep', ['60'], { stdio: 'ignore' })
  children.push(child)
  const pid = child.pid!
  const procStart = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
    env: { ...process.env, TZ: 'UTC' },
    encoding: 'utf8'
  }).trim()
  const dir = path.join(home, '.claude', 'sessions')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, `${pid}.json`), JSON.stringify({ pid, sessionId, procStart }))
  return child
}

function backendWithTab(): InstanceType<typeof ClaudeBackend> {
  return new ClaudeBackend({
    pty: { kill: () => {} },
    tracker: {
      remoteOf: () => undefined,
      infoOf: (tabId: string) => (tabId === TAB ? { sessionId: SID } : undefined),
      untrack: () => {}
    }
  } as unknown as ConstructorParameters<typeof ClaudeBackend>[0])
}

async function timed<T>(work: Promise<T>): Promise<{ value: T; ms: number }> {
  const at = Date.now()
  const value = await work
  return { value, ms: Date.now() - at }
}

// CC§11
describe('a Claude session whose tab Koloft has just closed', () => {
  it('is not running elsewhere once its old claude leaves a moment after the close, so a report sent right then resumes it', async () => {
    const old = oldClaudeHolding(SID)
    const backend = backendWithTab()
    backend.stop(TAB)
    setTimeout(() => old.kill('SIGKILL'), OLD_CLAUDE_LEAVES_AFTER_MS)
    expect(await backend.runningElsewhere(SID)).toBe(false)
  })

  it('a session Koloft never closed is running elsewhere at once, with no wait', async () => {
    oldClaudeHolding(SID)
    const { value, ms } = await timed(backendWithTab().runningElsewhere(SID))
    expect(value).toBe(true)
    expect(ms).toBeLessThan(OLD_CLAUDE_GOES_WITHIN_MS / 2)
  })

  it('an old claude still there when the wait runs out is running elsewhere', async () => {
    oldClaudeHolding(SID)
    const backend = backendWithTab()
    backend.stop(TAB)
    const { value, ms } = await timed(backend.runningElsewhere(SID))
    expect(value).toBe(true)
    expect(ms).toBeGreaterThanOrEqual(OLD_CLAUDE_GOES_WITHIN_MS - 100)
  }, 10_000)
})
