import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawn } from 'child_process'

vi.mock('electron', async () => {
  const nfs = await import('node:fs')
  const nos = await import('node:os')
  const npath = await import('node:path')
  const base = nfs.realpathSync(
    nfs.mkdtempSync(npath.join(nos.tmpdir(), 'koloft-shim-folder-text-'))
  )
  return { app: { getPath: () => base, getName: () => 'koloft-dev', isPackaged: false } }
})

import { app } from 'electron'
import { setupShim, type ShimPaths } from '../../src/main/shim'
import { CANNOT_WRITE_THE_REQUEST, everyAgentsShimScripts } from './helpers/agentShims'
import { startToolShim, type ToolShim } from '../../src/main/toolShim'
import { knowPluginStates } from '../../src/core/switches'

const PINNED = './shim-folder-text'
const GIT_REQUEST_DIR = '/fixture/git-requests'
const BUTLER_FOLDER = '/fixture/butler-folder'
const PLAYWRIGHT_BIN = '/fixture/playwright-bin'
const GIT_BIN = '/fixture/git-bin'
const GH_WRAPPER = '/fixture/shim/gh'
const USER_ZDOTDIR = '/fixture/users-zdotdir'
const RULES = 'Docs: sonnet, low.'
const TAB = 'tab-pinned'
const ACCOUNT_TOKEN_IN_THE_FAKE_KEYCHAIN = 'secret-from-the-fake-keychain'
const SHELL_GENERATED = new Set(['PWD', 'OLDPWD', 'SHLVL', '_'])
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g
const ALL_RUNS_OF_ONE_AGENT_END_WITHIN_MS = 30_000
const UMASK_OF_A_MAC_LOGIN = 0o022

const userData = (): string => app.getPath('userData')

let shared: ShimPaths
let scratch: string
let fakeBin: string
let securityOnlyBin: string

const sameOnEveryRun = (text: string): string =>
  text
    .replaceAll(userData(), '<userData>')
    .replaceAll(scratch, '<scratch>')
    .replace(new RegExp(`\\b${process.pid}-(?=<uuid>|[0-9a-f]{8}-)`, 'g'), '<pid>-')
    .replace(UUID, '<uuid>')
    .replace(/"ts":\d+/g, '"ts":<ts>')

const pin = (text: string, name: string): Promise<void> =>
  expect(sameOnEveryRun(text)).toMatchFileSnapshot(`${PINNED}/${name}`)

function modeOf(p: string): string {
  return (fs.lstatSync(p).mode & 0o777).toString(8).padStart(4, '0')
}

function listing(dir: string, textElsewhere: Record<string, string> = {}): string {
  return fs
    .readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .sort()
    .map((rel) => {
      const p = path.join(dir, rel)
      const st = fs.lstatSync(p)
      if (st.isSymbolicLink()) return `${rel}  link → ${fs.readlinkSync(p)}`
      if (st.isDirectory()) return `${rel}/  folder ${modeOf(p)}`
      const note = textElsewhere[rel] ? `  (${textElsewhere[rel]})` : ''
      return `${rel}  file ${modeOf(p)}${note}`
    })
    .join('\n')
    .concat('\n')
}

function scriptsIn(dir: string, skip: Set<string>): string[] {
  return fs
    .readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .sort()
    .filter((rel) => !skip.has(rel) && fs.lstatSync(path.join(dir, rel)).isFile())
}

function writeExecutable(file: string, text: string): void {
  fs.writeFileSync(file, text, { mode: 0o755 })
  fs.chmodSync(file, 0o755)
}

const RECORDING_AGENT = `#!/bin/sh
d="$KOLOFT_FAKE_DIR"
name="$(basename "$0")"
if [ "$1" = "--version" ]; then
  if [ -f "$d/$name-version" ]; then printf '%s (fake)\\n' "$(cat "$d/$name-version")"; else echo '999.0.0 (fake)'; fi
  exit 0
fi
if [ "$1" = "update" ] && [ -f "$d/$name-version" ]; then
  echo "update" >> "$d/$name-calls"
  [ -f "$d/$name-updates-to" ] && cp "$d/$name-updates-to" "$d/$name-version"
  exit 0
fi
: > "$d/$name-argv"
for a in "$@"; do printf '%s\\0' "$a" >> "$d/$name-argv"; done
env > "$d/$name-env"
exit 0
`

const FAKE_SECURITY_THAT_NEVER_REACHES_THE_REAL_KEYCHAIN = `#!/bin/sh
d="$KOLOFT_FAKE_DIR"
printf '%s\\n' "$*" >> "$d/security-calls"
if [ "$1" != find-generic-password ]; then echo "fake security: $* is not faked" >&2; exit 99; fi
acct=""; prev=""
for a in "$@"; do [ "$prev" = "-a" ] && acct="$a"; prev="$a"; done
[ -f "$d/keychain-$acct" ] && cat "$d/keychain-$acct" && exit 0
exit 44
`

beforeAll(() => {
  shared = setupShim(GIT_REQUEST_DIR, BUTLER_FOLDER, everyAgentsShimScripts())
  scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-shim-folder-runs-')))
  fakeBin = path.join(scratch, 'bin')
  securityOnlyBin = path.join(scratch, 'security-only')
  fs.mkdirSync(fakeBin)
  fs.mkdirSync(securityOnlyBin)
  for (const name of ['claude', 'codex', 'agy'])
    writeExecutable(path.join(fakeBin, name), RECORDING_AGENT)
  for (const dir of [fakeBin, securityOnlyBin])
    writeExecutable(path.join(dir, 'security'), FAKE_SECURITY_THAT_NEVER_REACHES_THE_REAL_KEYCHAIN)
})

afterAll(() => {
  fs.rmSync(userData(), { recursive: true, force: true })
  if (scratch) fs.rmSync(scratch, { recursive: true, force: true })
})

describe('the shim folder every session tab and shell tab on this Mac shares, pinned so that moving the code changes no character', () => {
  it('holds these files, each with this mode', () =>
    pin(listing(shared.shimDir), 'shared-folder/files.txt'))

  it('each file holds this text', async () => {
    const names = scriptsIn(shared.shimDir, new Set())
    expect(names.length).toBeGreaterThan(0)
    for (const name of names)
      await pin(
        fs.readFileSync(path.join(shared.shimDir, name), 'utf8'),
        `shared-folder/${name}.txt`
      )
  })

  it('a Koloft start writes every file again, putting back text and a mode someone changed', () => {
    const files = scriptsIn(shared.shimDir, new Set())
    const before = new Map(
      files.map((n) => [n, fs.readFileSync(path.join(shared.shimDir, n), 'utf8')])
    )
    for (const name of files) {
      fs.writeFileSync(path.join(shared.shimDir, name), '#!/bin/sh\nexit 9\n')
      fs.chmodSync(path.join(shared.shimDir, name), 0o644)
    }
    try {
      setupShim(GIT_REQUEST_DIR, BUTLER_FOLDER, everyAgentsShimScripts())
      expect(scriptsIn(shared.shimDir, new Set())).toEqual(files)
      for (const name of files) {
        expect(fs.readFileSync(path.join(shared.shimDir, name), 'utf8')).toBe(before.get(name))
        expect(modeOf(path.join(shared.shimDir, name))).toBe('0755')
      }
    } finally {
      for (const [name, text] of before) writeExecutable(path.join(shared.shimDir, name), text)
    }
  })

  it('with Passwords and sign-in turned off, rewriting the sudo files takes them out of the folder, and turned on again puts them back as they were', () => {
    const sudoFiles = ['koloft-askpass', 'sudo']
    const before = sudoFiles.map((n) => fs.readFileSync(path.join(shared.shimDir, n), 'utf8'))
    const everyFile = scriptsIn(shared.shimDir, new Set())
    knowPluginStates({ passwords: { on: false } })
    try {
      setupShim(GIT_REQUEST_DIR, BUTLER_FOLDER, everyAgentsShimScripts())
      expect(scriptsIn(shared.shimDir, new Set())).toEqual(
        everyFile.filter((n) => !sudoFiles.includes(n))
      )
    } finally {
      knowPluginStates({})
      setupShim(GIT_REQUEST_DIR, BUTLER_FOLDER, everyAgentsShimScripts())
    }
    expect(scriptsIn(shared.shimDir, new Set())).toEqual(everyFile)
    expect(sudoFiles.map((n) => fs.readFileSync(path.join(shared.shimDir, n), 'utf8'))).toEqual(
      before
    )
  })
})

describe('the shim folder Koloft writes for each Codex or Antigravity tab on this Mac, pinned so that moving the code changes no character', () => {
  const started: ToolShim[] = []
  let umaskBefore: number
  beforeAll(() => {
    umaskBefore = process.umask(UMASK_OF_A_MAC_LOGIN)
  })
  afterAll(() => {
    process.umask(umaskBefore)
  })
  afterEach(() => {
    for (const shim of started.splice(0)) shim.release()
  })

  const start = (backend: 'codex' | 'agy', agentTools: boolean): ToolShim => {
    const shim = startToolShim(
      {
        openShimRoot: path.join(userData(), `${backend}-open`),
        playwrightBin: PLAYWRIGHT_BIN,
        gitBin: GIT_BIN,
        ghWrapper: GH_WRAPPER
      },
      {
        backend,
        cannotWriteTheRequest: CANNOT_WRITE_THE_REQUEST[backend],
        userZdotdir: USER_ZDOTDIR,
        open: () => {},
        agent: agentTools ? () => {} : undefined,
        rules: RULES
      }
    )
    started.push(shim)
    return shim
  }

  const textsIn = (dir: string): Record<string, string> =>
    Object.fromEntries(
      scriptsIn(dir, new Set()).map((n) => [
        n,
        sameOnEveryRun(fs.readFileSync(path.join(dir, n), 'utf8'))
      ])
    )

  const GUIDE = {
    'koloft-guide.txt':
      "Koloft's agent guide with the project rules: its text is pinned by agentGuide.test.ts"
  }

  it.each(['codex', 'agy'] as const)(
    'a %s tab with agent tools on gets these files, each with this mode and this text, and a request folder only its owner can enter',
    async (backend) => {
      const { shim } = start(backend, true)
      const text = listing(shim.shimDir, GUIDE)
      await pin(
        `${text}\nrequest folder ${shim.requestDir}/  folder ${modeOf(shim.requestDir)}\n`,
        `${backend}-tab-folder/files.txt`
      )
      expect(modeOf(shim.requestDir)).toBe('0700')
      for (const name of scriptsIn(shim.shimDir, new Set(Object.keys(GUIDE))))
        await pin(
          fs.readFileSync(path.join(shim.shimDir, name), 'utf8'),
          `${backend}-tab-folder/${name}.txt`
        )
    }
  )

  it.each(['codex', 'agy'] as const)(
    'a %s tab with agent tools off gets no koloft command, no guide and no sudo files, and the rest is the same as with them on',
    (backend) => {
      const onlyWithThem = ['koloft', 'koloft-guide.txt', 'sudo', 'koloft-askpass']
      const on = start(backend, true).shim.shimDir
      const withThem = textsIn(on)
      for (const name of onlyWithThem) {
        expect(withThem).toHaveProperty([name])
        delete withThem[name]
      }
      const listingWithout = (dir: string): string[] =>
        sameOnEveryRun(listing(dir))
          .split('\n')
          .filter((line) => !onlyWithThem.includes(line.split('  ')[0]))
      const off = start(backend, false).shim.shimDir
      expect(textsIn(off)).toEqual(withThem)
      expect(listingWithout(off)).toEqual(listingWithout(on))
    }
  )

  it('each tab gets a folder of its own, and closing the tab removes it and its request folder', () => {
    const one = start('codex', true)
    const two = start('codex', false)
    expect(two.shim.shimDir).not.toBe(one.shim.shimDir)
    expect(two.shim.requestDir).not.toBe(one.shim.requestDir)
    two.release()
    expect(fs.existsSync(two.shim.shimDir)).toBe(false)
    expect(fs.existsSync(two.shim.requestDir)).toBe(false)
    expect(fs.existsSync(one.shim.shimDir)).toBe(true)
  })
})

interface Run {
  title: string
  bin: 'claude' | 'codex' | 'agy'
  args: string[]
  env?: Record<string, string>
  answer?: Record<string, unknown> | 'none'
  inATab?: boolean
  path?: 'without the real program'
  keychain?: Record<string, string>
  version?: { now: string; updatesTo?: string }
}

async function runShim(run: Run): Promise<string> {
  const dir = fs.mkdtempSync(path.join(scratch, 'run-'))
  const home = path.join(dir, 'home')
  const pickDir = path.join(dir, 'picks')
  const sessions = path.join(dir, 'sessions')
  for (const d of [home, pickDir, sessions]) fs.mkdirSync(d)
  for (const [account, token] of Object.entries(run.keychain ?? {}))
    fs.writeFileSync(path.join(dir, `keychain-${account}`), token)
  if (run.version) {
    fs.writeFileSync(path.join(dir, `${run.bin}-version`), run.version.now)
    if (run.version.updatesTo)
      fs.writeFileSync(path.join(dir, `${run.bin}-updates-to`), run.version.updatesTo)
  }
  const given: Record<string, string> = {
    PATH: `${shared.shimDir}:${run.path ? securityOnlyBin : fakeBin}:/usr/bin:/bin`,
    HOME: home,
    KOLOFT_FAKE_DIR: dir,
    KOLOFT_TAB_ID: TAB,
    KOLOFT_SESSION_DIR: sessions,
    ...(run.inATab === false ? {} : { KOLOFT_PICK_DIR: pickDir, KOLOFT_PID: String(process.pid) }),
    ...run.env
  }
  let asked: string | undefined
  const responder = setInterval(() => {
    try {
      const req = fs.readdirSync(pickDir).find((f) => f.startsWith('req-') && f.endsWith('.json'))
      if (!req || asked !== undefined) return
      const written = fs.readFileSync(path.join(pickDir, req), 'utf8')
      if (!written.endsWith('\n')) return
      asked = written
      if (run.answer === 'none' || run.answer === undefined) return
      const res = path.join(pickDir, `res-${req.slice('req-'.length)}`)
      fs.writeFileSync(`${res}.tmp`, JSON.stringify(run.answer))
      fs.renameSync(`${res}.tmp`, res)
    } catch {}
  }, 10)
  const { status, stderr } = await new Promise<{ status: number; stderr: string }>(
    (resolve, reject) => {
      const child = spawn(path.join(shared.shimDir, run.bin), run.args, {
        cwd: home,
        env: given,
        stdio: ['ignore', 'ignore', 'pipe']
      })
      let err = ''
      child.stderr.on('data', (c) => (err += c))
      child.on('error', reject)
      child.on('close', (code) => resolve({ status: code ?? -1, stderr: err }))
    }
  ).finally(() => clearInterval(responder))
  const read = (name: string): string | undefined =>
    fs.existsSync(path.join(dir, name)) ? fs.readFileSync(path.join(dir, name), 'utf8') : undefined
  const argv = read(`${run.bin}-argv`)
  const envText = read(`${run.bin}-env`)
  let envChange: string | undefined
  if (envText !== undefined) {
    const seen = new Map<string, string>()
    for (const line of envText.split('\n')) {
      const i = line.indexOf('=')
      if (i > 0) seen.set(line.slice(0, i), line.slice(i + 1))
    }
    const lines: string[] = []
    for (const [k, v] of [...seen].sort(([a], [b]) => (a < b ? -1 : 1)))
      if (!SHELL_GENERATED.has(k) && given[k] !== v) lines.push(`${k}=${v}`)
    for (const k of Object.keys(given).sort()) if (!seen.has(k)) lines.push(`${k} (taken away)`)
    envChange = lines.join('\n') || '(no change)'
  }
  const sections: [string, string | undefined][] = [
    ['exit code', String(status)],
    ['stderr', stderr || undefined],
    ['asked Koloft for an account', asked?.trimEnd()],
    ['asked the Keychain', read('security-calls')?.trimEnd()],
    ['updated the real program', read(`${run.bin}-calls`)?.trimEnd()],
    [
      `the real ${run.bin} got these arguments`,
      argv === undefined ? undefined : argv.split('\0').slice(0, -1).join('\n') || '(none)'
    ],
    ['its environment, where it differs from what the shim was given', envChange]
  ]
  return [
    `##### ${run.title}`,
    ...sections.filter(([, v]) => v !== undefined).map(([k, v]) => `--- ${k} ---\n${v}`)
  ].join('\n')
}

async function pinRuns(runs: Run[], name: string): Promise<void> {
  const told: string[] = []
  for (const run of runs) told.push(await runShim(run))
  await pin(told.join('\n\n') + '\n', name)
}

const LOGIN_SHELL_CLAUDE_SIGN_INS = {
  CLAUDE_CODE_OAUTH_TOKEN: 'exported-by-a-profile',
  ANTHROPIC_API_KEY: 'exported-by-a-profile',
  ANTHROPIC_AUTH_TOKEN: 'exported-by-a-profile'
}
const UTIL = { KOLOFT_UTIL: '1' }
const KEYCHAIN = { acct1: ACCOUNT_TOKEN_IN_THE_FAKE_KEYCHAIN }

describe('what each shim on this Mac does when it runs, as far as it is one agent’s own, pinned so that moving the code changes no character', () => {
  it(
    'Claude Code',
    () =>
      pinRuns(
        [
          {
            title: 'no real claude on PATH',
            bin: 'claude',
            args: [],
            path: 'without the real program'
          },
          {
            title: 'a new session on a subscription account, with sign-ins a login shell exported',
            bin: 'claude',
            args: [],
            env: LOGIN_SHELL_CLAUDE_SIGN_INS,
            answer: {
              account: 'acct1',
              kind: 'oauth',
              banner: 'koloft: → acct1',
              warning: 'every account is at its limit',
              skipFlag: true
            },
            keychain: KEYCHAIN
          },
          {
            title: 'a print run on an API key account',
            bin: 'claude',
            args: ['-p', 'say hi'],
            env: LOGIN_SHELL_CLAUDE_SIGN_INS,
            answer: { account: 'acct1', kind: 'apikey', banner: 'koloft: → acct1' },
            keychain: KEYCHAIN
          },
          {
            title:
              'a new session on a custom endpoint that pins its own model and would get a guessed window',
            bin: 'claude',
            args: ['--model', 'opus'],
            answer: {
              account: 'acct1',
              kind: 'custom',
              baseUrl: 'https://endpoint.example/v1',
              model: 'their-model',
              disable1mContext: true
            },
            keychain: KEYCHAIN
          },
          {
            title: 'an account Koloft already picked',
            bin: 'claude',
            args: [],
            env: { KOLOFT_ACCOUNT_PICKED: '1', CLAUDE_CODE_OAUTH_TOKEN: 'picked-by-koloft' }
          },
          { title: 'no usable account', bin: 'claude', args: [], answer: { account: null } },
          { title: 'Koloft never answers the pick', bin: 'claude', args: [], answer: 'none' },
          { title: 'outside a Koloft tab', bin: 'claude', args: [], inATab: false },
          {
            title: 'the account’s sign-in is not in the Keychain',
            bin: 'claude',
            args: [],
            answer: { account: 'ghost', kind: 'oauth' }
          },
          {
            title: 'older than the minimum, and the update lifts it',
            bin: 'claude',
            args: [],
            env: { KOLOFT_ACCOUNT_PICKED: '1' },
            version: { now: '0.0.1', updatesTo: '999.0.0' }
          },
          {
            title: 'older than the minimum, and the update cannot lift it',
            bin: 'claude',
            args: [],
            env: { KOLOFT_ACCOUNT_PICKED: '1' },
            version: { now: '0.0.1' }
          },
          {
            title: 'an interactive claude typed in a Koloft shell tab',
            bin: 'claude',
            args: [],
            env: UTIL
          }
        ],
        'runs/claude.txt'
      ),
    ALL_RUNS_OF_ONE_AGENT_END_WITHIN_MS
  )

  it(
    'Codex',
    () =>
      pinRuns(
        [
          {
            title: 'no real codex on PATH',
            bin: 'codex',
            args: ['exec', 'say hi'],
            path: 'without the real program'
          },
          {
            title: 'codex exec in a Koloft shell tab, with keys and a home a login shell exported',
            bin: 'codex',
            args: ['exec', 'say hi'],
            env: {
              ...UTIL,
              CODEX_API_KEY: 'exported-by-a-profile',
              OPENAI_API_KEY: 'exported-by-a-profile',
              CODEX_HOME: '/exported/home'
            },
            answer: {
              account: 'cx1',
              home: '/koloft/codex-homes/cx1',
              banner: 'koloft: → cx1',
              warning: 'every account is at its limit'
            }
          },
          {
            title: 'no usable account',
            bin: 'codex',
            args: ['exec', 'say hi'],
            env: UTIL,
            answer: { account: null }
          },
          {
            title: 'Koloft never answers the pick',
            bin: 'codex',
            args: ['exec', 'say hi'],
            env: UTIL,
            answer: 'none'
          },
          {
            title: 'outside a Koloft tab',
            bin: 'codex',
            args: ['exec', 'say hi'],
            env: UTIL,
            inATab: false
          },
          {
            title: 'an interactive codex typed in a Koloft shell tab',
            bin: 'codex',
            args: [],
            env: UTIL
          },
          {
            title: 'codex in a session’s own shell',
            bin: 'codex',
            args: [],
            env: { CODEX_HOME: '/exported/home' }
          }
        ],
        'runs/codex.txt'
      ),
    ALL_RUNS_OF_ONE_AGENT_END_WITHIN_MS
  )

  it(
    'Antigravity',
    () =>
      pinRuns(
        [
          {
            title: 'no real agy on PATH',
            bin: 'agy',
            args: ['-p', 'say hi'],
            path: 'without the real program'
          },
          {
            title:
              'agy -p in a Koloft shell tab on a Google account, with a key a login shell exported',
            bin: 'agy',
            args: ['-p', 'say hi'],
            env: { ...UTIL, GEMINI_API_KEY: 'exported-by-a-profile' },
            answer: {
              account: 'g1',
              home: '/koloft/agy-homes/g1',
              banner: 'koloft: → g1',
              warning: 'every account is at its limit'
            }
          },
          {
            title: 'agy -p in a Koloft shell tab on a key account',
            bin: 'agy',
            args: ['-p', 'say hi'],
            env: UTIL,
            answer: { account: 'acct1', home: '/koloft/agy-homes/acct1', kind: 'apikey' },
            keychain: KEYCHAIN
          },
          {
            title: 'the key account’s key is not in the Keychain',
            bin: 'agy',
            args: ['-p', 'say hi'],
            env: UTIL,
            answer: { account: 'ghost', home: '/h/ghost', kind: 'apikey' }
          },
          {
            title: 'no usable account',
            bin: 'agy',
            args: ['-p', 'say hi'],
            env: UTIL,
            answer: { account: null }
          },
          {
            title: 'Koloft never answers the pick',
            bin: 'agy',
            args: ['-p', 'say hi'],
            env: UTIL,
            answer: 'none'
          },
          {
            title: 'outside a Koloft tab',
            bin: 'agy',
            args: ['-p', 'say hi'],
            env: UTIL,
            inATab: false
          },
          {
            title: 'an interactive agy typed in a Koloft shell tab',
            bin: 'agy',
            args: [],
            env: UTIL
          },
          {
            title: 'agy in a session’s own shell',
            bin: 'agy',
            args: [],
            env: { GEMINI_API_KEY: 'exported-by-a-profile' }
          }
        ],
        'runs/agy.txt'
      ),
    ALL_RUNS_OF_ONE_AGENT_END_WITHIN_MS
  )
})
