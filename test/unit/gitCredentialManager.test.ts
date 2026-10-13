import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  browserUrlIn,
  credentialRequest,
  CredentialManager
} from '../../src/main/gitCredentialManager'

const QUIET_GET_TAKES_MS = 150
const MAC_TRACE =
  '12:00:00.000000 ...OpenBrowser.cs:10 trace: [OpenBrowser] Opening browser using framework shell-execute: https://x/authorize?a=1&b=2\n'
const LINUX_TRACE =
  "12:00:00.000000 ...LinuxSessionManager.cs:46 trace: [OpenBrowserInternal] Opening browser using '/usr/bin/xdg-open: https://x/authorize?a=1\n"

const FAKE_GCM = `
const fs = require('fs')
const op = process.argv[2]
let input = ''
process.stdin.on('data', (c) => (input += c))
process.stdin.on('end', () => {
  const start = Date.now()
  const env = {}
  for (const [k, v] of Object.entries(process.env))
    if (/^(GCM_|GIT_)/.test(k)) env[k] = v
  const finish = () => {
    fs.appendFileSync(process.env.FAKE_GCM_LOG, JSON.stringify({ op, input, env, start, end: Date.now() }) + '\\n')
    if (op === 'get') process.stdout.write('protocol=https\\nhost=x\\nusername=oauth2\\npassword=tok-' + process.env.GCM_NAMESPACE + '\\n')
  }
  if (op === 'get' && process.env.GCM_INTERACTIVE !== 'never') {
    process.stderr.write(${JSON.stringify(MAC_TRACE)})
    setTimeout(finish, 50)
  } else setTimeout(finish, op === 'get' ? ${QUIET_GET_TAKES_MS} : 0)
})
`

interface Logged {
  op: string
  input: string
  env: Record<string, string>
  start: number
  end: number
}

let root: string
let stateDir: string
let log: string
let gcm: CredentialManager

const logged = (): Logged[] =>
  fs
    .readFileSync(log, 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as Logged)

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-gcm-'))
  stateDir = path.join(root, 'gcm')
  log = path.join(root, 'log.jsonl')
  fs.writeFileSync(path.join(root, 'fake-gcm.js'), FAKE_GCM)
  process.env.KOLOFT_TEST_GCM = path.join(root, 'fake-gcm.js')
  delete process.env.KOLOFT_KEYCHAIN_FILE
  gcm = new CredentialManager({
    bin: undefined,
    stateDir,
    env: () => ({
      PATH: process.env.PATH,
      HOME: root,
      FAKE_GCM_LOG: log,
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'include.path',
      GIT_CONFIG_VALUE_0: '/koloft/master',
      GCM_CREDENTIAL_STORE: 'cache',
      GCM_TRACE: '/tmp/mine',
      GIT_TERMINAL_PROMPT: '1'
    })
  })
})

afterEach(() => {
  delete process.env.KOLOFT_TEST_GCM
  delete process.env.KOLOFT_KEYCHAIN_FILE
  fs.rmSync(root, { recursive: true, force: true })
})

const gitlab = { platform: 'gitlab' as const, url: 'https://gitlab.com', gcmNamespace: 'ns-a' }

describe('CredentialManager', () => {
  it('a quiet get runs in its own namespace, never prompts, reads only a Koloft-owned git config, and drops the user’s GCM settings and git config entries', async () => {
    expect(await gcm.get(gitlab)).toEqual({ username: 'oauth2', password: 'tok-ns-a' })
    const [run] = logged()
    expect(run.op).toBe('get')
    expect(run.env.GCM_NAMESPACE).toBe('ns-a')
    expect(run.env.GCM_INTERACTIVE).toBe('never')
    expect(run.env.GIT_TERMINAL_PROMPT).toBe('0')
    expect(run.env.GIT_CONFIG_NOSYSTEM).toBe('1')
    expect(path.dirname(run.env.GIT_CONFIG_GLOBAL)).toBe(stateDir)
    expect(run.env.GCM_CREDENTIAL_STORE).toBe('keychain')
    expect(run.env.GCM_TRACE).toBeUndefined()
    for (const k of ['GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0'])
      expect(run.env[k]).toBeUndefined()
  })

  it('under the test keychain file it keeps GCM’s store as plain files beside it, never in the Keychain', async () => {
    process.env.KOLOFT_KEYCHAIN_FILE = path.join(root, 'keychain.json')
    await gcm.get(gitlab)
    const [run] = logged()
    expect(run.env.GCM_CREDENTIAL_STORE).toBe('plaintext')
    expect(run.env.GCM_PLAINTEXT_STORE_PATH).toBe(path.join(root, 'gcm-store'))
  })

  it('an account without a namespace is never asked about', async () => {
    expect(await gcm.get({ platform: 'gitlab', url: 'https://gitlab.com' })).toBeNull()
    expect(fs.existsSync(log)).toBe(false)
  })

  it('two gets for one namespace run one after the other', async () => {
    await Promise.all([gcm.get(gitlab), gcm.get(gitlab)])
    const [a, b] = logged()
    expect(b.start).toBeGreaterThanOrEqual(a.end)
  })

  it('erase clears the token and every refresh-token entry the providers keep, all through the generic provider', async () => {
    await gcm.erase(gitlab)
    const runs = logged()
    expect(runs.map((r) => [r.op, r.env.GCM_PROVIDER])).toEqual(Array(4).fill(['erase', 'generic']))
    expect(runs.map((r) => r.input)).toEqual([
      'protocol=https\nhost=gitlab.com\n\n',
      'protocol=https\nhost=oauth-refresh-token.gitlab.com\n\n',
      'protocol=https\nhost=refresh_token.gitlab.com\n\n',
      'protocol=https\nhost=gitlab.com\npath=refresh_token\n\n'
    ])
  })

  it('signing in may prompt, traces, reports the page it opened and returns the credential', async () => {
    const opened: string[] = []
    const run = gcm.signIn({ ...gitlab, gcmNamespace: 'ns-b' }, (url) => opened.push(url))
    expect(await run.done).toEqual({ username: 'oauth2', password: 'tok-ns-b' })
    expect(opened).toEqual(['https://x/authorize?a=1&b=2'])
    const [signIn] = logged()
    expect(signIn.env.GCM_INTERACTIVE).toBeUndefined()
    expect(signIn.env.GIT_TERMINAL_PROMPT).toBeUndefined()
    expect(signIn.env.GCM_TRACE).toBe('1')
  })
})

describe('credentialRequest', () => {
  it('names the protocol and the host with its port; only a Gitea account adds the Gitea realm', () => {
    expect(
      credentialRequest({ platform: 'gitea', url: 'http://127.0.0.1:3000', gcmNamespace: 'n' })
    ).toBe('protocol=http\nhost=127.0.0.1:3000\nwwwauth[]=Basic realm="Gitea"\n\n')
    expect(credentialRequest(gitlab)).toBe('protocol=https\nhost=gitlab.com\n\n')
  })
})

describe('browserUrlIn', () => {
  it('reads the page GCM opened from its macOS and its Linux trace line', () => {
    expect(browserUrlIn(MAC_TRACE)).toBe('https://x/authorize?a=1&b=2')
    expect(browserUrlIn(LINUX_TRACE)).toBe('https://x/authorize?a=1')
    expect(browserUrlIn('12:00:00.000000 trace: [Main] Start\n')).toBeUndefined()
  })
})
