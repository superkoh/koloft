import { describe, it, expect, afterAll, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

import { defaultControlDir, ensureControlDir, runSsh, sshOptions } from '../../src/main/remote/ssh'

const UNIX_SOCKET_PATH_MAX_BYTES = 104

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-ssh-'))
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

describe('remote ssh options', () => {
  // PLATFORM§33
  it('U-SSH-1: creates the control folder ssh will not create for itself, private to this user', () => {
    const dir = path.join(tmp, 'ctl')
    ensureControlDir(dir)
    expect(fs.existsSync(dir)).toBe(true)
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700)
  })

  it('tightens an existing world-readable folder instead of leaving it open', () => {
    const dir = path.join(tmp, 'loose')
    fs.mkdirSync(dir, { mode: 0o755 })
    ensureControlDir(dir)
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700)
  })

  it('points every command at a socket inside that folder', () => {
    const dir = path.join(tmp, 'ctl')
    const opts = sshOptions(dir, false)
    expect(opts).toContain(`ControlPath=${dir}/%C`)
    expect(opts).toContain('ControlMaster=auto')
    expect(opts).toContain('ControlPersist=yes')
  })

  it('only a background command carries BatchMode — the tab shell must still be able to ask', () => {
    expect(sshOptions('/tmp/x', true)).toContain('BatchMode=yes')
    expect(sshOptions('/tmp/x', false)).not.toContain('BatchMode=yes')
  })

  it('the default folder is short and per-user', () => {
    expect(defaultControlDir()).toMatch(/^\/tmp\/koloft-\d+$/)
    // PLATFORM§3
    expect(`${defaultControlDir()}/%C`.length).toBeLessThan(UNIX_SOCKET_PATH_MAX_BYTES)
  })
})

describe("U-SSH-2: remote command result code is null on a local timeout, 127 for a missing binary, else the command's own", () => {
  const bin = path.join(tmp, 'bin')
  fs.mkdirSync(bin, { recursive: true })
  const fakeSsh = (body: string): void => {
    fs.writeFileSync(path.join(bin, 'ssh'), `#!/bin/sh\n${body}\n`, { mode: 0o755 })
  }
  const savedPath = process.env.PATH
  beforeEach(() => (process.env.PATH = bin))
  afterEach(() => (process.env.PATH = savedPath))

  it('a command that outlives the timeout comes back with no exit code', async () => {
    fakeSsh('/bin/sleep 5')
    const r = await runSsh('host', 'true', { controlDir: tmp, timeoutMs: 200 })
    expect(r.code).toBeNull()
  })

  it('a failing command keeps its own exit code and stderr', async () => {
    fakeSsh('echo boom >&2\nexit 3')
    const r = await runSsh('host', 'true', { controlDir: tmp })
    expect(r.code).toBe(3)
    expect(r.stderr).toContain('boom')
  })

  it('a missing ssh binary reads as 127, with the reason in stderr', async () => {
    process.env.PATH = tmp
    const r = await runSsh('host', 'true', { controlDir: tmp })
    expect(r.code).toBe(127)
    expect(r.stderr).toContain('ENOENT')
  })
})
