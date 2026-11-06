import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { execFile, execFileSync } from 'child_process'
import type { BytesResult } from '../../src/main/remote/ssh'

const GIT_TIMEOUT = 1_000
const SLOW_WALK_S = '0.6'

process.env.KOLOFT_GIT_TIMEOUT_MS = String(GIT_TIMEOUT)
const { SshHost } = await import('../../src/main/host/sshHost')

let home: string
let repo: string

function runOnSlowMachine(cmd: string, opts?: { timeoutMs?: number }): Promise<BytesResult> {
  return new Promise((resolve) => {
    execFile(
      '/bin/sh',
      ['-c', cmd],
      {
        env: { HOME: home, PATH: `${path.join(home, 'bin')}:/usr/bin:/bin` },
        encoding: 'buffer',
        timeout: opts?.timeoutMs,
        killSignal: 'SIGKILL'
      },
      (err, stdout, stderr) =>
        resolve({
          code: err ? (typeof err.code === 'number' ? err.code : null) : 0,
          stdout,
          stderr: String(stderr)
        })
    )
  })
}

beforeAll(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-slow-machine-')))
  repo = path.join(home, 'repo')
  fs.mkdirSync(path.join(home, 'bin'))
  fs.writeFileSync(
    path.join(home, 'bin', 'git'),
    `#!/bin/sh\ncase " $* " in *" diff "*|*" ls-files "*|*" status "*) sleep ${SLOW_WALK_S} ;; esac\nexec /usr/bin/git "$@"\n`,
    { mode: 0o755 }
  )
  fs.mkdirSync(repo)
  const git = (...args: string[]): string =>
    execFileSync('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
      encoding: 'utf8'
    })
  git('init', '-q', '-b', 'main')
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n')
  git('add', '-A')
  git('commit', '-qm', 'init')
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\ntwo\n')
})

afterAll(() => fs.rmSync(home, { recursive: true, force: true }))

describe('a remote Changes refresh on a slow machine', () => {
  it('still answers when each git walk takes most of the git timeout, as it did when each walk was its own ssh', async () => {
    const host = new SshHost('slowbox', {
      run: runOnSlowMachine,
      shell: () => ({ spawnCwd: '/' }),
      watch: () => {},
      unwatch: () => {},
      github: {},
      claude: {} as never
    })
    const changes = await host.gitChanges(`ssh://slowbox${repo}`, 'merge-base')
    expect(changes.status).toEqual({ [`ssh://slowbox${path.join(repo, 'a.txt')}`]: 'modified' })
    expect(changes.numstat[`ssh://slowbox${path.join(repo, 'a.txt')}`]).toEqual({
      added: 1,
      removed: 0
    })
  }, 20_000)
})
