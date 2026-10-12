import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { spawn } from 'child_process'
import {
  GIT_AUTH_WAITS_MS,
  ghWrapperScript,
  gitCredentialHelperScript
} from '../../src/main/gitCredentialScripts'
import { GitAuthRequests } from '../../src/main/gitAuthRequests'

let root: string
let requestDir: string
let scripts: string
let realGhDir: string
let ghLog: string
let helper: string
let watcher: fs.FSWatcher | null
let rejected: string[]

const ERASE_RETURNS_WITHOUT_WAITING_MS = 2000
const A_LOST_WATCH_EVENT_IS_SWEPT_UP_MS = 5000

interface Run {
  status: number | null
  stdout: string
  stderr: string
  ms: number
}

function run(file: string, args: string[], env: NodeJS.ProcessEnv = {}, input = ''): Promise<Run> {
  const started = Date.now()
  return new Promise((resolve) => {
    const child = spawn(file, args, {
      cwd: root,
      env: {
        PATH: `${scripts}:${realGhDir}:/usr/bin:/bin`,
        HOME: root,
        GIT_CONFIG_NOSYSTEM: '1',
        ...env
      }
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => (stdout += d))
    child.stderr.on('data', (d) => (stderr += d))
    child.on('close', (status) => resolve({ status, stdout, stderr, ms: Date.now() - started }))
    child.stdin.end(input)
  })
}

const inPickedRepo = {
  GIT_CONFIG_COUNT: '1',
  GIT_CONFIG_KEY_0: 'koloft.account',
  GIT_CONFIG_VALUE_0: 'bob'
}

beforeAll(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-gitscripts-')))
  requestDir = path.join(root, 'requests')
  scripts = path.join(root, 'shim dir')
  realGhDir = path.join(root, 'real')
  ghLog = path.join(root, 'gh.log')
  for (const d of [requestDir, scripts, realGhDir]) fs.mkdirSync(d)
  helper = path.join(scripts, 'git-credential-koloft')
  fs.writeFileSync(helper, gitCredentialHelperScript(requestDir), { mode: 0o755 })
  fs.writeFileSync(path.join(scripts, 'gh'), ghWrapperScript(requestDir), { mode: 0o755 })
  fs.writeFileSync(
    path.join(realGhDir, 'gh'),
    `#!/bin/sh\necho "argv=$* token=$GH_TOKEN host=$GH_HOST github_token=$GITHUB_TOKEN" >> '${ghLog}'\n`,
    { mode: 0o755 }
  )
  rejected = []
  watcher = new GitAuthRequests({
    token: async (_host, login) => (login === 'bob' ? 'gho_bob' : null),
    rejected: (_host, login) => void rejected.push(login)
  }).watch(requestDir)
})

afterAll(() => {
  watcher?.close()
  fs.rmSync(root, { recursive: true, force: true })
})

beforeEach(() => {
  fs.rmSync(ghLog, { force: true })
})

describe('git credential helper', () => {
  it("get prints the account's token Koloft hands over, and leaves no request or reply behind", async () => {
    const r = await run(helper, ['bob', 'get'], {}, 'protocol=https\nhost=github.com\n\n')
    expect(r.status).toBe(0)
    expect(r.stdout).toBe('username=bob\npassword=gho_bob\n')
    expect(fs.readdirSync(requestDir)).toEqual([])
  })

  it('get for an account Koloft has no token for prints nothing, so git goes on without it', async () => {
    const r = await run(helper, ['eve', 'get'], {}, 'protocol=https\n\n')
    expect(r.status).toBe(0)
    expect(r.stdout).toBe('')
  })

  it('erase tells Koloft the token was turned down and returns without waiting for an answer', async () => {
    const r = await run(helper, ['carol', 'erase'], {}, 'protocol=https\n\n')
    expect(r.status).toBe(0)
    expect(r.ms).toBeLessThan(ERASE_RETURNS_WITHOUT_WAITING_MS)
    await expect
      .poll(() => rejected, { timeout: A_LOST_WATCH_EVENT_IS_SWEPT_UP_MS })
      .toEqual(['carol'])
  })

  it('store is swallowed: Koloft keeps the token, git never writes it anywhere', async () => {
    const r = await run(
      helper,
      ['bob', 'store'],
      {},
      'protocol=https\nusername=bob\npassword=x\n\n'
    )
    expect(r.status).toBe(0)
    expect(r.stdout).toBe('')
  })

  it('with Koloft gone it fails with one line, at once when the request folder is missing', async () => {
    const lonely = path.join(root, 'lonely')
    fs.writeFileSync(lonely, gitCredentialHelperScript(path.join(root, 'no-such-dir')), {
      mode: 0o755
    })
    const r = await run(lonely, ['bob', 'get'], {}, 'protocol=https\n\n')
    expect(r.status).toBe(1)
    expect(r.stderr).toBe('koloft: could not reach Koloft for git credentials.\n')
  })

  it(
    'with nobody answering it gives up after its wait with the same line, and takes its request back',
    async () => {
      const silentDir = path.join(root, 'silent')
      fs.mkdirSync(silentDir)
      const silent = path.join(root, 'silent-helper')
      fs.writeFileSync(silent, gitCredentialHelperScript(silentDir), { mode: 0o755 })
      const r = await run(silent, ['bob', 'get'], {}, 'protocol=https\n\n')
      expect(r.status).toBe(1)
      expect(r.stderr).toBe('koloft: could not reach Koloft for git credentials.\n')
      expect(fs.readdirSync(silentDir)).toEqual([])
    },
    GIT_AUTH_WAITS_MS + 5000
  )
})

describe('gh wrapper', () => {
  const gh = (): string => path.join(scripts, 'gh')

  it('outside a picked repository it is the next gh, gh auth login included', async () => {
    const r = await run(gh(), ['auth', 'login'], { GITHUB_TOKEN: 'mine' })
    expect(r.status).toBe(0)
    expect(fs.readFileSync(ghLog, 'utf8')).toBe('argv=auth login token= host= github_token=mine\n')
  })

  it("inside a picked repository it refuses gh's own sign-in commands", async () => {
    const r = await run(gh(), ['auth', 'login'], inPickedRepo)
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('Koloft git account bob')
    expect(fs.existsSync(ghLog)).toBe(false)
  })

  it("inside a picked repository the next gh runs on the account's token for github.com, never on a token from the environment", async () => {
    const r = await run(gh(), ['pr', 'view'], { ...inPickedRepo, GITHUB_TOKEN: 'mine' })
    expect(r.status).toBe(0)
    expect(fs.readFileSync(ghLog, 'utf8')).toBe(
      'argv=pr view token=gho_bob host=github.com github_token=\n'
    )
  })

  it('a picked account Koloft has no token for stops gh with a pointer to Settings', async () => {
    const r = await run(gh(), ['pr', 'view'], { ...inPickedRepo, GIT_CONFIG_VALUE_0: 'eve' })
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('did not hand over the token for eve')
    expect(fs.existsSync(ghLog)).toBe(false)
  })

  it('skips another copy of itself on PATH, as a Codex tab links it into its own shim folder', async () => {
    const tabShim = path.join(root, 'tab shim')
    fs.mkdirSync(tabShim)
    fs.symlinkSync(gh(), path.join(tabShim, 'gh'))
    const r = await run(path.join(tabShim, 'gh'), ['pr', 'list'], {
      PATH: `${tabShim}:${scripts}:${realGhDir}:/usr/bin:/bin`
    })
    expect(r.status).toBe(0)
    expect(fs.readFileSync(ghLog, 'utf8')).toBe('argv=pr list token= host= github_token=\n')
  })
})
