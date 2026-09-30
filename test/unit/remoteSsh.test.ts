import { describe, it, expect, afterAll, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'

import {
  defaultControlDir,
  ensureControlDir,
  problemOf,
  runSsh,
  sshOptions
} from '../../src/main/remote/ssh'

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

// PLATFORM§33
describe("a user's ~/.ssh/config cannot turn Koloft's commands into something else", () => {
  const resolved = (args: string[]): string => {
    const config = path.join(tmp, 'user-config')
    fs.writeFileSync(config, 'Host *\n  RemoteCommand tmux attach\n  RequestTTY force\n')
    return execFileSync('/usr/bin/ssh', ['-G', '-F', config, ...args, 'devbox'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    })
  }

  it('drops a RemoteCommand the config sets, for background commands and tabs alike', () => {
    expect(resolved(sshOptions('/tmp/x', true))).not.toMatch(/^remotecommand /m)
    expect(resolved(sshOptions('/tmp/x', false))).not.toMatch(/^remotecommand /m)
  })

  it('gives no command a terminal unless it asks with -t, so the bytes a tab pushes first arrive intact, while its session still gets one', () => {
    expect(resolved(['-n', ...sshOptions('/tmp/x', true)])).toMatch(/^requesttty false$/m)
    expect(resolved(sshOptions('/tmp/x', false))).toMatch(/^requesttty false$/m)
    expect(resolved(['-tt', ...sshOptions('/tmp/x', false)])).toMatch(/^requesttty force$/m)
    expect(resolved(['-t', ...sshOptions('/tmp/x', false)])).toMatch(/^requesttty true$/m)
  })
})

describe('when the shared connection to a machine has no room for another command', () => {
  const bin = path.join(tmp, 'spillbin')
  const calls = path.join(tmp, 'spill-calls')
  fs.mkdirSync(bin, { recursive: true })
  const savedPath = process.env.PATH
  const sshThat = (body: string): void =>
    fs.writeFileSync(
      path.join(bin, 'ssh'),
      `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(calls)}\n${body}\n`,
      { mode: 0o755 }
    )
  const socketsUsed = (): string[] =>
    fs
      .readFileSync(calls, 'utf8')
      .trim()
      .split('\n')
      .map((l) => /ControlPath=\S+\/(%C\S*)/.exec(l)?.[1] ?? '')
  beforeEach(() => {
    process.env.PATH = `${bin}:/usr/bin:/bin`
    fs.rmSync(calls, { force: true })
  })
  afterEach(() => (process.env.PATH = savedPath))

  // PLATFORM§33
  it('background commands move to a connection of their own, and back once that one cannot be made', async () => {
    const opts = { controlDir: tmp }
    sshThat(
      'echo "mux_client_request_session: session request failed: Session open refused by peer" >&2'
    )
    await runSsh('full-box', 'true', opts)
    sshThat('exit 0')
    await runSsh('full-box', 'true', opts)
    await runSsh('other-box', 'true', opts)
    sshThat('echo "Permission denied (publickey,password)." >&2; exit 255')
    await runSsh('full-box', 'true', opts)
    await runSsh('full-box', 'true', opts)
    expect(socketsUsed()).toEqual(['%C', '%C-spill', '%C', '%C-spill', '%C'])
  })
})

describe('what the sidebar says when a machine cannot be reached', () => {
  it("passes on ssh's own last word, and tells the user how to sign in when ssh needed someone to", () => {
    expect(
      problemOf({
        code: 255,
        stderr: 'ssh: Could not resolve hostname devbx: nodename nor servname\n'
      })
    ).toBe('ssh: Could not resolve hostname devbx: nodename nor servname')
    expect(
      problemOf({ code: 255, stderr: 'kuser@devbox: Permission denied (publickey,password).\n' })
    ).toBe(
      'kuser@devbox: Permission denied (publickey,password). — start a session on this machine and sign in there'
    )
    expect(problemOf({ code: 255, stderr: 'Host key verification failed.\n' })).toMatch(/sign in/)
    expect(problemOf({ code: null, stderr: '' })).toBe('ssh timed out')
  })

  it('names a full shared connection and a shell that prints at login, which ssh itself does not explain', () => {
    expect(
      problemOf({
        code: 255,
        stderr:
          'mux_client_request_session: session request failed: Session open refused by peer\nPermission denied (password).\n'
      })
    ).toMatch(/MaxSessions/)
    // PLATFORM§34
    expect(
      problemOf({ code: 1, stderr: 'rsync(73905): error: unexpected tag 103 (0x6e6f6320)\n' })
    ).toMatch(/prints text when it starts/)
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
