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
import { GitAuthRequests, type GitAuthRequest } from '../../src/main/gitAuthRequests'

let root: string
let requestDir: string
let scripts: string
let realGhDir: string
let ghLog: string
let helper: string
let butlerFolder: string
let watcher: fs.FSWatcher | null
let rejected: string[]
let asked: GitAuthRequest[]

const ERASE_RETURNS_WITHOUT_WAITING_MS = 2000
const A_LOST_WATCH_EVENT_IS_SWEPT_UP_MS = 5000
const BOB = 'github.com/bob'
const CAROL_ON_GHES = 'ghe.example.com:8443/carol'

interface Run {
  status: number | null
  stdout: string
  stderr: string
  ms: number
}

function run(
  file: string,
  args: string[],
  env: NodeJS.ProcessEnv = {},
  input = '',
  cwd = root
): Promise<Run> {
  const started = Date.now()
  return new Promise((resolve) => {
    const child = spawn(file, args, {
      cwd,
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

function pickedFor(account: string, platform: string, host: string): NodeJS.ProcessEnv {
  return {
    GIT_CONFIG_COUNT: '3',
    GIT_CONFIG_KEY_0: 'koloft.account',
    GIT_CONFIG_VALUE_0: account,
    GIT_CONFIG_KEY_1: 'koloft.platform',
    GIT_CONFIG_VALUE_1: platform,
    GIT_CONFIG_KEY_2: 'koloft.host',
    GIT_CONFIG_VALUE_2: host
  }
}

const inPickedRepo = pickedFor(BOB, 'github', 'github.com')

beforeAll(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-gitscripts-')))
  requestDir = path.join(root, 'requests')
  scripts = path.join(root, 'shim dir')
  realGhDir = path.join(root, 'real')
  ghLog = path.join(root, 'gh.log')
  for (const d of [requestDir, scripts, realGhDir]) fs.mkdirSync(d)
  helper = path.join(scripts, 'git-credential-koloft')
  fs.writeFileSync(helper, gitCredentialHelperScript(requestDir), { mode: 0o755 })
  butlerFolder = path.join(root, 'conductors', 'global')
  fs.mkdirSync(butlerFolder, { recursive: true })
  fs.writeFileSync(path.join(scripts, 'gh'), ghWrapperScript(requestDir, butlerFolder), {
    mode: 0o755
  })
  fs.writeFileSync(path.join(scripts, 'koloft'), `#!/bin/sh\necho "koloft $*" >> '${ghLog}'\n`, {
    mode: 0o755
  })
  fs.writeFileSync(
    path.join(realGhDir, 'gh'),
    `#!/bin/sh\necho "argv=$* token=$GH_TOKEN host=$GH_HOST github_token=$GITHUB_TOKEN enterprise=$GH_ENTERPRISE_TOKEN" >> '${ghLog}'\n`,
    { mode: 0o755 }
  )
  rejected = []
  asked = []
  const token = (account: string): string | null =>
    account === BOB || account === CAROL_ON_GHES ? 'gho_bob' : null
  watcher = new GitAuthRequests({
    credential: async (req) => {
      asked.push(req)
      const t = token(req.account)
      return t ? { username: 'bob-at-server', password: t } : null
    },
    ghToken: async (account) => token(account),
    rejected: (account) => void rejected.push(account)
  }).watch(requestDir)
})

afterAll(() => {
  watcher?.close()
  fs.rmSync(root, { recursive: true, force: true })
})

beforeEach(() => {
  fs.rmSync(ghLog, { force: true })
  asked = []
})

describe('git credential helper', () => {
  it('get prints the username and token Koloft hands over, and leaves no request or reply behind', async () => {
    const r = await run(helper, [BOB, 'get'], {}, 'protocol=https\nhost=github.com\n\n')
    expect(r.status).toBe(0)
    expect(r.stdout).toBe('username=bob-at-server\npassword=gho_bob\n')
    expect(fs.readdirSync(requestDir)).toEqual([])
  })

  it('hands Koloft the account and the protocol and host (port included) git asked about', async () => {
    await run(
      helper,
      ['127.0.0.1:3000/dev', 'get'],
      {},
      'protocol=http\nhost=127.0.0.1:3000\npath=acme/app.git\n\n'
    )
    expect(asked).toEqual([
      {
        kind: 'credential',
        account: '127.0.0.1:3000/dev',
        protocol: 'http',
        host: '127.0.0.1:3000'
      }
    ])
  })

  it('get for an account Koloft has no token for prints nothing, so git goes on without it', async () => {
    const r = await run(helper, ['github.com/eve', 'get'], {}, 'protocol=https\n\n')
    expect(r.status).toBe(0)
    expect(r.stdout).toBe('')
  })

  it('erase tells Koloft the token was turned down and returns without waiting for an answer', async () => {
    const r = await run(helper, ['github.com/carol', 'erase'], {}, 'protocol=https\n\n')
    expect(r.status).toBe(0)
    expect(r.ms).toBeLessThan(ERASE_RETURNS_WITHOUT_WAITING_MS)
    await expect
      .poll(() => rejected, { timeout: A_LOST_WATCH_EVENT_IS_SWEPT_UP_MS })
      .toEqual(['github.com/carol'])
  })

  it('store is swallowed: Koloft keeps the token, git never writes it anywhere', async () => {
    const r = await run(helper, [BOB, 'store'], {}, 'protocol=https\nusername=bob\npassword=x\n\n')
    expect(r.status).toBe(0)
    expect(r.stdout).toBe('')
  })

  it('with Koloft gone it fails with one line, at once when the request folder is missing', async () => {
    const lonely = path.join(root, 'lonely')
    fs.writeFileSync(lonely, gitCredentialHelperScript(path.join(root, 'no-such-dir')), {
      mode: 0o755
    })
    const r = await run(lonely, [BOB, 'get'], {}, 'protocol=https\n\n')
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
      const r = await run(silent, [BOB, 'get'], {}, 'protocol=https\n\n')
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
    expect(fs.readFileSync(ghLog, 'utf8')).toBe(
      'argv=auth login token= host= github_token=mine enterprise=\n'
    )
  })

  it("inside a picked repository it refuses gh's own sign-in commands", async () => {
    const r = await run(gh(), ['auth', 'login'], inPickedRepo)
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('Koloft git account github.com/bob')
    expect(fs.existsSync(ghLog)).toBe(false)
  })

  it("inside a picked repository the next gh runs on the account's token for github.com, never on a token from the environment", async () => {
    const r = await run(gh(), ['pr', 'view'], { ...inPickedRepo, GITHUB_TOKEN: 'mine' })
    expect(r.status).toBe(0)
    expect(fs.readFileSync(ghLog, 'utf8')).toBe(
      'argv=pr view token=gho_bob host=github.com github_token= enterprise=\n'
    )
  })

  it('a repository picked for a GitHub Enterprise account gives gh the enterprise token and that server, and no github.com token', async () => {
    const r = await run(gh(), ['pr', 'view'], {
      ...pickedFor(CAROL_ON_GHES, 'ghes', 'ghe.example.com:8443'),
      GH_TOKEN: 'mine'
    })
    expect(r.status).toBe(0)
    expect(fs.readFileSync(ghLog, 'utf8')).toBe(
      'argv=pr view token= host=ghe.example.com:8443 github_token= enterprise=gho_bob\n'
    )
  })

  it('a repository picked for a GitLab account leaves gh alone: no request, no refused sign-in', async () => {
    const r = await run(gh(), ['auth', 'login'], {
      ...pickedFor('gitlab.com/dev', 'gitlab', 'gitlab.com'),
      GH_TOKEN: 'mine'
    })
    expect(r.status).toBe(0)
    expect(fs.readFileSync(ghLog, 'utf8')).toBe(
      'argv=auth login token=mine host= github_token= enterprise=\n'
    )
    expect(asked).toEqual([])
  })

  it('a picked account Koloft has no token for stops gh with a pointer to Settings', async () => {
    const r = await run(gh(), ['pr', 'view'], {
      ...inPickedRepo,
      GIT_CONFIG_VALUE_0: 'github.com/eve'
    })
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('did not hand over the token for github.com/eve')
    expect(fs.existsSync(ghLog)).toBe(false)
  })

  it("in the butler's folder, and below it, gh is koloft gh with the same words, so Koloft's process signs it in", async () => {
    const below = path.join(butlerFolder, 'notes')
    fs.mkdirSync(below, { recursive: true })
    await run(gh(), ['pr', 'view', '389', '--repo', 'acme/app'], {}, '', butlerFolder)
    await run(gh(), ['issue', 'list', '-R', 'acme/app'], {}, '', below)
    expect(fs.readFileSync(ghLog, 'utf8')).toBe(
      'koloft gh pr view 389 --repo acme/app\nkoloft gh issue list -R acme/app\n'
    )
  })

  it("in the butler's folder a Codex tab's linked copy runs the koloft of that tab's own shim folder", async () => {
    const tabShim = path.join(root, 'butler tab shim')
    fs.mkdirSync(tabShim)
    fs.symlinkSync(gh(), path.join(tabShim, 'gh'))
    fs.writeFileSync(
      path.join(tabShim, 'koloft'),
      `#!/bin/sh\necho "tab koloft $*" >> '${ghLog}'\n`,
      { mode: 0o755 }
    )
    await run(path.join(tabShim, 'gh'), ['pr', 'list'], {}, '', butlerFolder)
    expect(fs.readFileSync(ghLog, 'utf8')).toBe('tab koloft gh pr list\n')
  })

  it('skips another copy of itself on PATH, as a Codex tab links it into its own shim folder', async () => {
    const tabShim = path.join(root, 'tab shim')
    fs.mkdirSync(tabShim)
    fs.symlinkSync(gh(), path.join(tabShim, 'gh'))
    const r = await run(path.join(tabShim, 'gh'), ['pr', 'list'], {
      PATH: `${tabShim}:${scripts}:${realGhDir}:/usr/bin:/bin`
    })
    expect(r.status).toBe(0)
    expect(fs.readFileSync(ghLog, 'utf8')).toBe(
      'argv=pr list token= host= github_token= enterprise=\n'
    )
  })
})
