import { describe, it, expect, afterEach } from 'vitest'
import { spawn, type ChildProcess } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { rootsWithClaude } from '../../src/main/claudeLiveness'

// The ps-based fallback that decides a bound session's claude is gone (and untracks
// the tab). Real processes, real `ps` — reading the OS IS the probe's job, so a mocked
// ps would test nothing. The stand-in is a sh script named `claude` (copying a signed
// system binary under another name gets the copy SIGKILLed on macOS).

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-liveness-'))
// the runner must not carry "claude" in its own ps command — that is what makes the
// descendant case prove the tree walk rather than the root match
const fakeClaude = path.join(dir, 'claude')
const runner = path.join(dir, 'runner.sh')
fs.writeFileSync(fakeClaude, '#!/bin/sh\nsleep 30\n', { mode: 0o755 })
fs.writeFileSync(runner, `#!/bin/sh\n${fakeClaude}; true\n`, { mode: 0o755 })

const kids: ChildProcess[] = []
function spawned(cmd: string, args: string[] = []): ChildProcess {
  const p = spawn(cmd, args, { stdio: 'ignore' })
  kids.push(p)
  return p
}

/** ps needs a moment to see a freshly forked tree */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 400))

/** positive sightings poll: a fixed sleep loses the race under load (the gates run
 *  flaked at 400ms once the whole suite was hammering the box) — the fork is coming,
 *  the only question is when ps sees it */
const seen = (pid: number): (() => Promise<boolean>) => {
  // null = ps itself failed ("can't tell") — for the poll that just means "not yet"
  return async () => (await rootsWithClaude([pid]))?.has(pid) ?? false
}

afterEach(() => {
  for (const k of kids.splice(0)) k.kill('SIGKILL')
})

describe('rootsWithClaude', () => {
  // A session pty runs `exec claude` (agent-centric §9: no shell wraps it any more),
  // so the ROOT process is claude itself. Skipping the root — the old assumption that
  // "the shell's own command is never claude" — reports every live session as gone,
  // untracking the tab and reverting it mid-session.
  it('sees claude when the root pid IS the claude process', async () => {
    const p = spawned(fakeClaude)
    await expect.poll(seen(p.pid!), { timeout: 5000, interval: 150 }).toBe(true)
  })

  it('still sees claude running as a descendant of a shell root', async () => {
    const p = spawned(runner)
    await expect.poll(seen(p.pid!), { timeout: 5000, interval: 150 }).toBe(true)
  })

  it('reports a root with no claude anywhere as not alive', async () => {
    const p = spawned('/bin/sleep', ['30'])
    await settle()
    expect(await rootsWithClaude([p.pid!])).toEqual(new Set())
  })
})
