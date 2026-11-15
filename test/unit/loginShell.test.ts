import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  agentsInLoginShell,
  forgetAgentsInLoginShell,
  readLoginShell,
  sshEnvFromLogin
} from '../../src/main/loginShell'

let zdotdir: string

beforeEach(() => {
  zdotdir = fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-login-'))
})

afterEach(() => fs.rmSync(zdotdir, { recursive: true, force: true }))

// PLATFORM§1
describe("background ssh gets what the user's own terminal has", () => {
  it('picks up the PATH and ssh agent the login files set, behind the PATH the app already had', async () => {
    fs.writeFileSync(path.join(zdotdir, '.zprofile'), 'export PATH="/opt/kt-tools/bin:$PATH"\n')
    fs.writeFileSync(
      path.join(zdotdir, '.zshrc'),
      'echo "welcome banner"\nexport SSH_AUTH_SOCK=/tmp/kt-agent.sock\n'
    )
    const app = {
      PATH: '/app/fakebin:/usr/bin:/bin',
      SSH_AUTH_SOCK: '/var/run/launchd-agent',
      ZDOTDIR: zdotdir
    }
    const login = await readLoginShell({ shell: '/bin/zsh', env: app, timeoutMs: 8000 })

    const adopted = sshEnvFromLogin(app, login.env)
    expect(adopted.SSH_AUTH_SOCK).toBe('/tmp/kt-agent.sock')
    expect(adopted.PATH?.startsWith('/app/fakebin:/usr/bin:/bin:')).toBe(true)
    expect(adopted.PATH?.split(':')).toContain('/opt/kt-tools/bin')
    expect(new Set(adopted.PATH?.split(':')).size).toBe(adopted.PATH?.split(':').length)
  })

  it('changes nothing when the login files add nothing', () => {
    expect(sshEnvFromLogin({ PATH: '/usr/bin:/bin' }, { PATH: '/bin:/usr/bin' })).toEqual({})
  })
})

describe('one login shell answers every agent lookup at startup', () => {
  function countingZsh(then = 'exec /bin/zsh "$@"'): { shell: string; runs: () => number } {
    const log = path.join(zdotdir, 'runs')
    const shell = path.join(zdotdir, 'zsh')
    fs.writeFileSync(shell, `#!/bin/sh\necho run >> '${log}'\n${then}\n`, {
      mode: 0o700
    })
    return {
      shell,
      runs: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').length - 1 : 0)
    }
  }

  afterEach(() => {
    forgetAgentsInLoginShell()
    vi.useRealTimers()
  })

  it('runs the shell once for every agent and the environment, each name looked up on its own', async () => {
    fs.mkdirSync(path.join(zdotdir, 'bin'))
    fs.writeFileSync(path.join(zdotdir, 'bin', 'codex'), '#!/bin/sh\n', { mode: 0o700 })
    fs.writeFileSync(
      path.join(zdotdir, '.zshrc'),
      'export PATH="$ZDOTDIR/bin:$PATH"\nexport KT_FROM_RC=yes\nclaude() { :; }\n'
    )
    const { shell, runs } = countingZsh()
    const env = { PATH: '/usr/bin:/bin', ZDOTDIR: zdotdir }
    const [first, ...rest] = await Promise.all([
      agentsInLoginShell(env, shell),
      agentsInLoginShell(env, shell),
      agentsInLoginShell(env, shell)
    ])
    expect(runs()).toBe(1)
    for (const other of rest) expect(other).toBe(first)
    expect(first.env.KT_FROM_RC).toBe('yes')
    expect(first.commandV).toEqual({
      claude: 'claude',
      codex: path.join(zdotdir, 'bin', 'codex'),
      muse: '',
      agy: ''
    })
  })

  it('answers every name even when the profile stops the shell at the first failing command', async () => {
    fs.writeFileSync(path.join(zdotdir, '.zshrc'), 'setopt ERR_EXIT\n')
    const { shell } = countingZsh()
    const round = await agentsInLoginShell({ PATH: '/usr/bin:/bin', ZDOTDIR: zdotdir }, shell)
    expect(round.commandV.muse).toBe('')
    expect(round.env.PATH).toBeTruthy()
  })

  it('reads the answer of a shell that printed everything and then exited non-zero', async () => {
    fs.writeFileSync(path.join(zdotdir, '.zshrc'), 'claude() { :; }\n')
    const { shell } = countingZsh('/bin/zsh "$@"\nexit 1')
    const round = await agentsInLoginShell({ PATH: '/usr/bin:/bin', ZDOTDIR: zdotdir }, shell)
    expect(round.commandV.claude).toBe('claude')
  })

  it('never hands a shell that failed to the next caller', async () => {
    const { shell, runs } = countingZsh('exit 3')
    const env = { PATH: '/usr/bin:/bin', ZDOTDIR: zdotdir }
    await expect(agentsInLoginShell(env, shell)).rejects.toThrow()
    await expect(agentsInLoginShell(env, shell)).rejects.toThrow()
    expect(runs()).toBe(2)
  })

  it('asks a fresh shell for the 60 s re-ask of a missing agent, and right after a recheck', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const { shell, runs } = countingZsh()
    const env = { PATH: '/usr/bin:/bin', ZDOTDIR: zdotdir }
    await agentsInLoginShell(env, shell)
    vi.advanceTimersByTime(60_000)
    await agentsInLoginShell(env, shell)
    expect(runs()).toBe(2)
    forgetAgentsInLoginShell()
    await agentsInLoginShell(env, shell)
    expect(runs()).toBe(3)
  })
})
