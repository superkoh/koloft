import { spawnSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: {} }))

const { ghCredentialScript, gitCredentialEnv, pathWithDirLast, pickedGhAccountEnv } =
  await import('../../src/main/bundledGh')

let home: string
let ghCalls: string
let helperPath: string

const FAKE_GH = `#!/bin/sh
printf '%s\\n' "$*" >> "$GH_CALLS"
cat > /dev/null
printf 'protocol=https\\nhost=github.com\\nusername=gh-user\\npassword=gh-token\\n'
`

function setup(): NodeJS.ProcessEnv {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-ghcred-'))
  ghCalls = path.join(home, 'gh-calls.txt')
  const gh = path.join(home, 'gh')
  fs.writeFileSync(gh, FAKE_GH, { mode: 0o755 })
  const helper = path.join(home, 'gh-credential')
  helperPath = helper
  fs.writeFileSync(helper, ghCredentialScript(gh), { mode: 0o755 })
  const base: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: home,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GH_CALLS: ghCalls
  }
  return { ...base, ...gitCredentialEnv(base, helper) }
}

function fill(env: NodeJS.ProcessEnv, url: string): string | null {
  const r = spawnSync('git', ['credential', 'fill'], { env, input: `url=${url}\n\n`, cwd: home })
  if (r.status !== 0) return null
  return /^username=(.*)$/m.exec(r.stdout.toString())?.[1] ?? null
}

function useStoredAccount(env: NodeJS.ProcessEnv, user: string): void {
  spawnSync('git', ['config', '--global', 'credential.helper', 'store'], { env, cwd: home })
  fs.writeFileSync(path.join(home, '.git-credentials'), `https://${user}:pw@github.com\n`)
}

const ghWasAsked = (): boolean => fs.existsSync(ghCalls)

describe("Koloft's last-resort GitHub credential helper", () => {
  let env: NodeJS.ProcessEnv
  beforeEach(() => {
    env = setup()
  })
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }))

  it('on a machine with nothing configured, a push to github.com gets the gh account', () => {
    expect(fill(env, 'https://github.com/o/r.git')).toBe('gh-user')
  })

  it("leaves an account the user's own helper holds in charge, and gh is never asked", () => {
    useStoredAccount(env, 'alice')
    expect(fill(env, 'https://github.com/o/r.git')).toBe('alice')
    expect(ghWasAsked()).toBe(false)
  })

  it('stays silent for a URL that names its user, so a multi-account remote fails as it does today', () => {
    expect(fill(env, 'https://bob@github.com/o/r.git')).toBeNull()
    expect(ghWasAsked()).toBe(false)
  })

  it('is not asked for any other host', () => {
    expect(fill(env, 'https://gitlab.com/o/r.git')).toBeNull()
    expect(ghWasAsked()).toBe(false)
  })

  it('ignores the store and erase git sends after a push, so nothing reaches gh', () => {
    const cred = 'protocol=https\nhost=github.com\nusername=gh-user\npassword=gh-token\n\n'
    spawnSync('git', ['credential', 'approve'], { env, input: cred, cwd: home })
    spawnSync('git', ['credential', 'reject'], { env, input: cred, cwd: home })
    expect(ghWasAsked()).toBe(false)
  })

  it("in a workspace that picked an account, only Koloft's helper answers — over a stored account, a named user and a GH_TOKEN-free shell — and a push stores nothing", () => {
    useStoredAccount(env, 'alice')
    const picked = { ...env, ...pickedGhAccountEnv(env, helperPath, 'tok-bob') }
    expect(fill(picked, 'https://github.com/o/r.git')).toBe('gh-user')
    expect(fill(picked, 'https://alice@github.com/o/r.git')).toBe('gh-user')
    const stored = fs.readFileSync(path.join(home, '.git-credentials'), 'utf8')
    const cred = 'protocol=https\nhost=github.com\nusername=gh-user\npassword=gh-token\n\n'
    spawnSync('git', ['credential', 'approve'], { env: picked, input: cred, cwd: home })
    expect(fs.readFileSync(path.join(home, '.git-credentials'), 'utf8')).toBe(stored)
    expect(picked.GH_TOKEN).toBe('tok-bob')
  })

  it('an unpicked workspace with GH_TOKEN in the shell still stays silent for a URL that names its user', () => {
    expect(fill({ ...env, GH_TOKEN: 'from-shell' }, 'https://bob@github.com/o/r.git')).toBeNull()
  })

  it("adds its config after any the user's environment already passes to git", () => {
    const vars = gitCredentialEnv(
      { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'user.name', GIT_CONFIG_VALUE_0: 'me' },
      '/h'
    )
    expect(vars.GIT_CONFIG_COUNT).toBe('3')
    expect(vars.GIT_CONFIG_KEY_1).toBe('credential.https://github.com.helper')
    expect(vars.GIT_CONFIG_KEY_2).toBe('credential.https://gist.github.com.helper')
    expect(vars.GIT_CONFIG_KEY_0).toBeUndefined()
  })
})

describe('pathWithDirLast', () => {
  it('puts the folder last, once, so a gh the user installed is found first', () => {
    const once = pathWithDirLast('/opt/homebrew/bin:/usr/bin', '/k/bin')
    expect(once).toBe('/opt/homebrew/bin:/usr/bin:/k/bin')
    expect(pathWithDirLast(once, '/k/bin')).toBe(once)
  })
})
