import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { GitLoginProgress } from '@shared/types'
import {
  DENY_KEYCHAIN_PROFILE,
  GithubLogin,
  parseLoginOutput,
  readHostsYml,
  sandboxBlocksKeychain,
  type GithubLoginDeps
} from '../../src/main/githubLogin'

const FAKE_GH_LOGIN = path.resolve(__dirname, '../e2e/fixtures/fake-gh-login.js')
const TOKEN_VARIABLES = [
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'GH_ENTERPRISE_TOKEN',
  'GITHUB_ENTERPRISE_TOKEN'
]

const GH_2_102_STDERR =
  '\n! First copy your one-time code: AB12-CD34\nOpen this URL to continue in your web browser: https://github.com/login/device\n'

describe('parseLoginOutput', () => {
  it('reads the one-time code and the device URL from what gh 2.102 prints with no terminal', () => {
    expect(parseLoginOutput(GH_2_102_STDERR)).toEqual({
      code: 'AB12-CD34',
      url: 'https://github.com/login/device'
    })
  })

  it('finds nothing in a half-written first line', () => {
    expect(parseLoginOutput('\n! First copy your one-time code: AB1')).toEqual({})
  })
})

describe('readHostsYml', () => {
  it('reads the signed-in login and its token from what an --insecure-storage login writes', () => {
    const yml =
      'github.com:\n    users:\n        bob:\n            oauth_token: gho_bob\n    git_protocol: https\n    oauth_token: gho_bob\n    user: bob\n'
    expect(readHostsYml(yml, 'github.com')).toEqual({ login: 'bob', token: 'gho_bob' })
  })

  it('a hosts.yml whose token lives in the keychain gives no sign-in', () => {
    expect(
      readHostsYml('github.com:\n    users:\n        bob:\n    user: bob\n', 'github.com')
    ).toBeNull()
  })

  it('reads the entry of the server it signed in to, so a GitHub Enterprise sign-in never reads github.com', () => {
    const yml =
      'github.com:\n    oauth_token: gho_other\n    user: other\nghe.example.com:8443:\n    oauth_token: gho_carol\n    user: carol\n'
    expect(readHostsYml(yml, 'ghe.example.com:8443')).toEqual({
      login: 'carol',
      token: 'gho_carol'
    })
  })
})

describe.runIf(process.platform === 'darwin')('sandboxBlocksKeychain', () => {
  let dir: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-sb-'))
  })
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('is true for the deny-keychain profile: true still runs, security does not', async () => {
    const profile = path.join(dir, 'deny.sb')
    fs.writeFileSync(profile, DENY_KEYCHAIN_PROFILE)
    expect(await sandboxBlocksKeychain(profile)).toBe(true)
  })

  it('is false when the sandbox cannot even run /usr/bin/true', async () => {
    const profile = path.join(dir, 'broken.sb')
    fs.writeFileSync(
      profile,
      '(version 1)\n(allow default)\n(deny process-exec (literal "/usr/bin/true"))\n(deny process-exec (literal "/usr/bin/security"))\n'
    )
    expect(await sandboxBlocksKeychain(profile)).toBe(false)
  })
})

describe('GithubLogin with the fake gh', () => {
  let root: string
  let userData: string
  let fakeHome: string
  let progress: GitLoginProgress[]
  let pages: string[]
  let saved: { url: string; token: string }[]
  let login: GithubLogin

  const loginDirs = (): string[] =>
    fs.readdirSync(userData).filter((n) => n.startsWith('gh-login-'))

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-ghlogin-'))
    userData = path.join(root, 'Application Support', 'koloft')
    fakeHome = path.join(root, 'home')
    fs.mkdirSync(userData, { recursive: true })
    fs.mkdirSync(fakeHome)
    process.env.KOLOFT_TEST_GH_LOGIN = FAKE_GH_LOGIN
    process.env.KOLOFT_FAKE_GH_LOGIN_HOME = fakeHome
    process.env.KOLOFT_FAKE_GH_LOGIN_AS = 'bob'
    process.env.KOLOFT_FAKE_GH_LOGIN_TOKEN = 'gho_fake_bob'
    progress = []
    pages = []
    saved = []
    const deps: GithubLoginDeps = {
      ghBin: undefined,
      userData,
      openInBrowser: (url) => void pages.push(url),
      progress: (p) => progress.push(p),
      signedIn: async (url, token) => {
        if (token !== 'gho_fake_bob') return { ok: false, message: 'not accepted' }
        saved.push({ url, token })
        return { ok: true, login: 'bob' }
      }
    }
    login = new GithubLogin(deps)
  })

  afterEach(() => {
    login.cancel()
    for (const k of [
      'KOLOFT_TEST_GH_LOGIN',
      'KOLOFT_FAKE_GH_LOGIN_HOME',
      'KOLOFT_FAKE_GH_LOGIN_AS',
      'KOLOFT_FAKE_GH_LOGIN_TOKEN'
    ])
      delete process.env[k]
    fs.rmSync(root, { recursive: true, force: true })
  })

  const codeShown = (): Promise<void> =>
    vi.waitFor(() => expect(progress.some((p) => p.phase === 'code')).toBe(true), {
      timeout: 5000
    })

  it('shows the code, opens the device page in the browser, then saves the account GitHub names and leaves no login folder', async () => {
    expect(await login.start('https://github.com')).toEqual({ ok: true })
    await codeShown()
    expect(progress).toContainEqual({
      phase: 'code',
      code: 'ABCD-1234',
      url: 'https://github.com/login/device'
    })
    expect(pages).toEqual(['https://github.com/login/device'])
    fs.writeFileSync(path.join(fakeHome, 'approve-gh-login'), '')
    await vi.waitFor(() => expect(progress.at(-1)).toEqual({ phase: 'saved', login: 'bob' }), {
      timeout: 5000
    })
    expect(saved).toEqual([{ url: 'https://github.com', token: 'gho_fake_bob' }])
    expect(loginDirs()).toEqual([])
  })

  it('hands gh no token variable and a PATH that is one empty folder inside its own login folder', async () => {
    await login.start('https://github.com')
    await codeShown()
    const log = fs.readFileSync(path.join(fakeHome, 'fake-gh-login-env.txt'), 'utf8')
    const keys = /^keys (.*)$/m.exec(log)![1].split(' ')
    const pathDir = /^PATH (.*)$/m.exec(log)![1]
    for (const t of TOKEN_VARIABLES) expect(keys).not.toContain(t)
    expect(keys).not.toContain('SSH_AUTH_SOCK')
    expect(path.dirname(path.dirname(pathDir))).toBe(userData)
    expect(fs.readdirSync(pathDir)).toEqual([])
    expect(/^argv (.*)$/m.exec(log)![1]).toBe(
      'auth login --web --insecure-storage --git-protocol https --hostname github.com -s repo,read:org,gist,workflow --clipboard=false'
    )
  })

  it('a GitHub Enterprise sign-in names that server to gh', async () => {
    await login.start('https://ghe.example.com:8443')
    await codeShown()
    const log = fs.readFileSync(path.join(fakeHome, 'fake-gh-login-env.txt'), 'utf8')
    expect(/^argv (.*)$/m.exec(log)![1]).toContain('--hostname ghe.example.com:8443 ')
  })

  it('a GitHub Enterprise server with no device flow: gh prints only an authorize address, which opens as a browser sign-in', async () => {
    const webOnly = path.join(root, 'web-only-login.js')
    fs.writeFileSync(
      webOnly,
      "process.stderr.write('Open this URL to continue in your web browser: https://ghe.example.com/login/oauth/authorize?client_id=x&state=y\\n')\nsetInterval(() => {}, 1000)\n"
    )
    process.env.KOLOFT_TEST_GH_LOGIN = webOnly
    await login.start('https://ghe.example.com')
    const authorize = 'https://ghe.example.com/login/oauth/authorize?client_id=x&state=y'
    await vi.waitFor(() => expect(progress).toContainEqual({ phase: 'browser', url: authorize }), {
      timeout: 5000
    })
    expect(pages).toEqual([authorize])
  })

  it('a device address with no code yet is not shown before its code arrives', async () => {
    const half = path.join(root, 'half-login.js')
    fs.writeFileSync(
      half,
      "process.stderr.write('Open this URL to continue in your web browser: https://github.com/login/device\\n')\nsetInterval(() => {}, 1000)\n"
    )
    process.env.KOLOFT_TEST_GH_LOGIN = half
    await login.start('https://github.com')
    await new Promise((r) => setTimeout(r, 300))
    expect(progress).toEqual([{ phase: 'checking' }])
    expect(pages).toEqual([])
  })

  it('a second start while one runs is busy', async () => {
    await login.start('https://github.com')
    expect(await login.start('https://github.com')).toEqual({ ok: false, error: 'busy' })
  })

  it('a refused device login reports failed and removes the login folder', async () => {
    await login.start('https://github.com')
    await codeShown()
    fs.writeFileSync(path.join(fakeHome, 'deny-gh-login'), '')
    await vi.waitFor(() => expect(progress.at(-1)?.phase).toBe('failed'), { timeout: 5000 })
    expect(saved).toEqual([])
    expect(loginDirs()).toEqual([])
  })

  it('cancel stops gh, removes the login folder and reports nothing more', async () => {
    await login.start('https://github.com')
    await codeShown()
    const seen = progress.length
    login.cancel()
    expect(loginDirs()).toEqual([])
    fs.writeFileSync(path.join(fakeHome, 'approve-gh-login'), '')
    await new Promise((r) => setTimeout(r, 300))
    expect(progress.length).toBe(seen)
    expect(saved).toEqual([])
    expect(await login.start('https://github.com')).toEqual({ ok: true })
  })

  it('with no fake and no bundled gh it says no-gh', async () => {
    delete process.env.KOLOFT_TEST_GH_LOGIN
    expect(await login.start('https://github.com')).toEqual({ ok: false, error: 'no-gh' })
  })
})
