import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { readLoginShell, sshEnvFromLogin } from '../../src/main/loginShell'

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
