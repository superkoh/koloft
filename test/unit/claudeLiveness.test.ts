import { describe, it, expect, afterEach } from 'vitest'
import { spawn, type ChildProcess } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { rootsWithClaude } from '../../src/main/claudeLiveness'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-liveness-'))
// PLATFORM§3
const fakeClaude = path.join(dir, 'claude')
const runnerWithNoClaudeInItsOwnCommandLine = path.join(dir, 'runner.sh')
fs.writeFileSync(fakeClaude, '#!/bin/sh\nsleep 30\n', { mode: 0o755 })
fs.writeFileSync(runnerWithNoClaudeInItsOwnCommandLine, `#!/bin/sh\n${fakeClaude}; true\n`, {
  mode: 0o755
})

const kids: ChildProcess[] = []
function spawned(cmd: string, args: string[] = []): ChildProcess {
  const p = spawn(cmd, args, { stdio: 'ignore' })
  kids.push(p)
  return p
}

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 400))

const seen = (pid: number): (() => Promise<boolean>) => {
  return async () => (await rootsWithClaude([pid]))?.has(pid) ?? false
}

afterEach(() => {
  for (const k of kids.splice(0)) k.kill('SIGKILL')
})

describe('rootsWithClaude', () => {
  it('sees claude when the root pid IS the claude process (a session pty execs claude with no shell around it)', async () => {
    const p = spawned(fakeClaude)
    await expect.poll(seen(p.pid!), { timeout: 5000, interval: 150 }).toBe(true)
  })

  it('still sees claude running as a descendant of a shell root', async () => {
    const p = spawned(runnerWithNoClaudeInItsOwnCommandLine)
    await expect.poll(seen(p.pid!), { timeout: 5000, interval: 150 }).toBe(true)
  })

  it('reports a root with no claude anywhere as not alive', async () => {
    const p = spawned('/bin/sleep', ['30'])
    await settle()
    expect(await rootsWithClaude([p.pid!])).toEqual(new Set())
  })
})

describe('rootsWithClaude when ps cannot be read', () => {
  const realPath = process.env.PATH
  const fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-liveness-ps-'))

  function fakePs(body: string): void {
    fs.writeFileSync(path.join(fakeBin, 'ps'), `#!/bin/sh\n${body}\n`, { mode: 0o755 })
    process.env.PATH = `${fakeBin}:${realPath}`
  }

  afterEach(() => {
    process.env.PATH = realPath
  })

  it('answers null, never an empty set, when ps fails — an empty set would untrack every live claude tab within two sweeps', async () => {
    fakePs(`echo '${process.pid} 1 node'; exit 1`)
    expect(await rootsWithClaude([process.pid])).toBeNull()
  })

  it('answers null, never an empty set, when the ps output parses to zero rows — an empty set would untrack every live claude tab within two sweeps', async () => {
    fakePs("echo 'PID PPID COMMAND'; echo 'not a process row'")
    expect(await rootsWithClaude([process.pid])).toBeNull()
  })
})
