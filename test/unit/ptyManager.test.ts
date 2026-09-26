import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import os from 'os'

const mocks = vi.hoisted(() => {
  // PLATFORM§29
  const state: {
    processName: unknown
    exit?: (e: { exitCode: number; signal?: number }) => void
    data?: (d: string) => void
  } = { processName: 'zsh' }
  const proc = {
    pid: 4242,
    onData: (cb: (d: string) => void) => {
      state.data = cb
    },
    onExit: (cb: (e: { exitCode: number; signal?: number }) => void) => {
      state.exit = cb
    },
    write: () => {},
    resize: () => {},
    kill: () => {},
    get process(): string {
      return state.processName as string
    }
  }
  return { proc, state, spawn: vi.fn((..._args: unknown[]) => proc) }
})
vi.mock('node-pty', () => ({ spawn: mocks.spawn }))

import { PtyManager, foregroundName, tabInstancePid } from '../../src/main/ptyManager'

const POLLUTANTS = {
  CLAUDE_CODE_ENTRYPOINT: 'cli',
  CLAUDECODE: '1',
  CLAUDE_EFFORT: 'high',
  AI_AGENT: '1',
  TERM_SESSION_ID: 'w0t1p0:ABC',
  KOLOFT_SESSION_DIR: '/parent-koloft/reg',
  KOLOFT_OPEN_DIR: '/parent-koloft/opens',
  KOLOFT_HOOK_SETTINGS: '/parent-koloft/hooks/pty-x-1.json',
  KOLOFT_AGENT_DIR: '/parent-koloft/agent',
  KOLOFT_AGENT_PLUGIN: '/parent-koloft/agent-plugin',
  ANT_ACCOUNT: 'whoever-started-koloft'
}

let saved: Record<string, string | undefined>

beforeEach(() => {
  mocks.spawn.mockClear()
  mocks.state.processName = 'zsh'
  mocks.state.exit = undefined
  mocks.state.data = undefined
  saved = {}
  for (const [k, v] of Object.entries(POLLUTANTS)) {
    saved[k] = process.env[k]
    process.env[k] = v
  }
  for (const k of ['LC_ALL', 'LANG', 'LC_CTYPE']) {
    saved[k] = process.env[k]
    delete process.env[k]
  }
})

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

function spawnedEnv(): Record<string, string> {
  const opts = mocks.spawn.mock.calls[0][2] as { env: Record<string, string> }
  return opts.env
}

describe('PtyManager per-tab environment', () => {
  it("strips inherited env that would mislead a tab: a nested claude would skip its transcript, a parent Koloft's dirs would grow ghost rows in the parent, and a parent's ANT_ACCOUNT would mislabel every tab", () => {
    const mgr = new PtyManager()
    mgr.create({ kind: 'shell', cwd: os.tmpdir() })
    const env = spawnedEnv()
    for (const k of Object.keys(POLLUTANTS)) expect(env[k]).toBeUndefined()
    expect(Object.keys(env).some((k) => k.startsWith('CLAUDE_CODE_'))).toBe(false)
  })

  it('prepends the shim dir to PATH and injects the tab / reg / open / hook env', () => {
    const mgr = new PtyManager()
    mgr.shimDir = '/koloft/shim'
    mgr.regDir = '/koloft/reg'
    mgr.openDir = '/koloft/opens'
    mgr.makeHookSettings = (id) => `/koloft/hooks/${id}.json`
    const handle = mgr.create({ kind: 'claude', cwd: os.tmpdir() })
    const env = spawnedEnv()
    expect(env.PATH.startsWith('/koloft/shim:')).toBe(true)
    expect(env.KOLOFT_TAB_ID).toBe(handle.id)
    expect(env.KOLOFT_SESSION_DIR).toBe('/koloft/reg')
    expect(env.KOLOFT_OPEN_DIR).toBe('/koloft/opens')
    expect(env.KOLOFT_PID).toBe(String(process.pid))
    expect(env.KOLOFT_HOOK_SETTINGS).toBe(`/koloft/hooks/${handle.id}.json`)
    // PLATFORM§2
    expect(env.TERM_PROGRAM).toBe('Apple_Terminal')
  })

  it('hands the koloft request folder and the skill plugin only to a tab whose kind and machine may use agent tools, and gives a utility shell the folder but not the plugin', () => {
    const allowed: string[] = []
    const envFor = (args: Parameters<PtyManager['create']>[0]): Record<string, string> => {
      mocks.spawn.mockClear()
      const mgr = new PtyManager()
      mgr.agentDir = '/koloft/agent'
      mgr.agentPlugin = '/koloft/agent-plugin'
      mgr.agentToolsFor = (kind, host) => allowed.includes(`${kind}@${host}`)
      mgr.create(args)
      return spawnedEnv()
    }
    allowed.push('claude@local', 'shell@local')
    const local = envFor({ kind: 'claude', cwd: os.tmpdir() })
    expect(local.KOLOFT_AGENT_DIR).toBe('/koloft/agent')
    expect(local.KOLOFT_AGENT_PLUGIN).toBe('/koloft/agent-plugin')
    const util = envFor({ kind: 'shell', cwd: os.tmpdir(), util: true })
    expect(util.KOLOFT_AGENT_DIR).toBe('/koloft/agent')
    expect(util.KOLOFT_AGENT_PLUGIN).toBeUndefined()
    const remote = envFor({ kind: 'claude', cwd: os.tmpdir(), host: 'ssh' })
    expect(remote.KOLOFT_AGENT_DIR).toBeUndefined()
    expect(remote.KOLOFT_AGENT_PLUGIN).toBeUndefined()
  })

  it('marks a global-terminal (utility) shell with KOLOFT_UTIL=1, the variable the shim hard block keys off', () => {
    const mgr = new PtyManager()
    mgr.create({ kind: 'shell', cwd: os.tmpdir(), util: true })
    const env = spawnedEnv()
    expect(env.KOLOFT_UTIL).toBe('1')
    expect(env.KOLOFT_AUX).toBeUndefined()
  })

  it('never leaks KOLOFT_UTIL into a session pty, even when Koloft itself inherited one', () => {
    process.env.KOLOFT_UTIL = '1'
    try {
      const mgr = new PtyManager()
      mgr.create({ kind: 'claude', cwd: os.tmpdir() })
      expect(spawnedEnv().KOLOFT_UTIL).toBeUndefined()
    } finally {
      delete process.env.KOLOFT_UTIL
    }
  })

  it('strips the retired aux markers an older Koloft in the ancestry still exports, rather than passing them down', () => {
    process.env.KOLOFT_AUX = '1'
    process.env.KOLOFT_AUX_TITLE = 'somebody else’s session'
    try {
      const mgr = new PtyManager()
      mgr.create({ kind: 'claude', cwd: os.tmpdir() })
      expect(spawnedEnv().KOLOFT_AUX).toBeUndefined()
      expect(spawnedEnv().KOLOFT_AUX_TITLE).toBeUndefined()
    } finally {
      delete process.env.KOLOFT_AUX
      delete process.env.KOLOFT_AUX_TITLE
    }
  })

  it('withholds the session-bound env (registration, hook settings) from a utility shell so a claude -p there grows no ghost row, but keeps open interception and the rest', () => {
    const mgr = new PtyManager()
    mgr.shimDir = '/koloft/shim'
    mgr.regDir = '/koloft/reg'
    mgr.openDir = '/koloft/opens'
    mgr.pickDir = '/koloft/picks'
    mgr.makeHookSettings = (id) => `/koloft/hooks/${id}.json`
    const handle = mgr.create({ kind: 'shell', cwd: os.tmpdir(), util: true })
    const env = spawnedEnv()
    expect(env.KOLOFT_SESSION_DIR).toBeUndefined()
    expect(env.KOLOFT_HOOK_SETTINGS).toBeUndefined()
    expect(env.KOLOFT_OPEN_DIR).toBe('/koloft/opens')
    expect(env.KOLOFT_TAB_ID).toBe(handle.id)
    expect(env.KOLOFT_PID).toBe(String(process.pid))
    expect(env.KOLOFT_PICK_DIR).toBe('/koloft/picks')
    expect(env.PATH.startsWith('/koloft/shim:')).toBe(true)
  })

  it('drops an inherited ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN while balancing is on, since the shim yields to any token already in the env', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-ambient'
    process.env.ANTHROPIC_AUTH_TOKEN = 'ambient-token'
    try {
      const mgr = new PtyManager()
      mgr.multiAccountOn = () => true
      mgr.create({ kind: 'claude', cwd: os.tmpdir() })
      const env = spawnedEnv()
      expect(env.ANTHROPIC_API_KEY).toBeUndefined()
      expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined()
    } finally {
      delete process.env.ANTHROPIC_API_KEY
      delete process.env.ANTHROPIC_AUTH_TOKEN
    }
  })

  it("keeps them when balancing is off: they are the user's own auth and Koloft has none to put in their place", () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-ambient'
    process.env.ANTHROPIC_AUTH_TOKEN = 'ambient-token'
    try {
      const mgr = new PtyManager()
      mgr.create({ kind: 'claude', cwd: os.tmpdir() })
      const env = spawnedEnv()
      expect(env.ANTHROPIC_API_KEY).toBe('sk-ant-ambient')
      expect(env.ANTHROPIC_AUTH_TOKEN).toBe('ambient-token')
    } finally {
      delete process.env.ANTHROPIC_API_KEY
      delete process.env.ANTHROPIC_AUTH_TOKEN
    }
  })

  it("never lets an inherited browser endpoint reach a utility shell: it would point at the parent instance's browser", () => {
    process.env.KOLOFT_CDP_DIR = '/parent/koloft/cdp'
    process.env.KOLOFT_BROWSER_CDP = 'ws://127.0.0.1:9999/cdp/' + 'a'.repeat(32)
    process.env.PLAYWRIGHT_MCP_CDP_ENDPOINT = process.env.KOLOFT_BROWSER_CDP
    process.env.PLAYWRIGHT_CLI_SESSION = 'koloft-parent-tab'
    process.env.PLAYWRIGHT_MCP_ALLOW_UNRESTRICTED_FILE_ACCESS = '1'
    try {
      const mgr = new PtyManager()
      mgr.create({ kind: 'shell', cwd: os.tmpdir(), util: true })
      const env = spawnedEnv()
      expect(env.KOLOFT_CDP_DIR).toBeUndefined()
      expect(env.KOLOFT_BROWSER_CDP).toBeUndefined()
      expect(env.PLAYWRIGHT_MCP_CDP_ENDPOINT).toBeUndefined()
      expect(env.PLAYWRIGHT_CLI_SESSION).toBeUndefined()
      expect(env.PLAYWRIGHT_MCP_ALLOW_UNRESTRICTED_FILE_ACCESS).toBeUndefined()
    } finally {
      delete process.env.KOLOFT_CDP_DIR
      delete process.env.KOLOFT_BROWSER_CDP
      delete process.env.PLAYWRIGHT_MCP_CDP_ENDPOINT
      delete process.env.PLAYWRIGHT_CLI_SESSION
      delete process.env.PLAYWRIGHT_MCP_ALLOW_UNRESTRICTED_FILE_ACCESS
    }
  })

  it('forces a UTF-8 locale when none is inherited', () => {
    const mgr = new PtyManager()
    mgr.create({ kind: 'shell', cwd: os.tmpdir() })
    expect(spawnedEnv().LANG).toBe('en_US.UTF-8')
  })

  it('removes KOLOFT_KEYCHAIN_FILE from a tab unless KOLOFT_TEST_BACKGROUND=1, so a stale export in a profile can never redirect the shim’s credential reads in a real run', () => {
    const background = process.env.KOLOFT_TEST_BACKGROUND
    process.env.KOLOFT_KEYCHAIN_FILE = '/stale/keychain.json'
    try {
      delete process.env.KOLOFT_TEST_BACKGROUND
      new PtyManager().create({ kind: 'claude', cwd: os.tmpdir() })
      expect(spawnedEnv().KOLOFT_KEYCHAIN_FILE).toBeUndefined()

      mocks.spawn.mockClear()
      process.env.KOLOFT_TEST_BACKGROUND = '1'
      new PtyManager().create({ kind: 'claude', cwd: os.tmpdir() })
      expect(spawnedEnv().KOLOFT_KEYCHAIN_FILE).toBe('/stale/keychain.json')
    } finally {
      delete process.env.KOLOFT_KEYCHAIN_FILE
      if (background === undefined) delete process.env.KOLOFT_TEST_BACKGROUND
      else process.env.KOLOFT_TEST_BACKGROUND = background
    }
  })
})

describe('PtyManager handles after the pty exits', () => {
  it('keeps an exited pty findable through get() until reapDead() runs at teardown, so a late SessionStart hook for a tab that just died still finds its handle', () => {
    const mgr = new PtyManager()
    const h = mgr.create({ kind: 'claude', cwd: os.tmpdir() })
    mocks.state.exit?.({ exitCode: 0 })
    expect(mgr.get(h.id)).toBe(h)
    expect(h.alive).toBe(false)

    mgr.reapDead()
    expect(mgr.get(h.id)).toBeUndefined()
  })
})

describe('tabInstancePid', () => {
  it('answers process.pid for an id PtyManager.create() minted and null for a malformed id, so a registration from another live Koloft is left alone', () => {
    const h = new PtyManager().create({ kind: 'claude', cwd: os.tmpdir() })
    expect(tabInstancePid(h.id)).toBe(process.pid)
    expect(tabInstancePid(`pty-${(98765).toString(36)}-3`)).toBe(98765)
    expect(tabInstancePid('tab-1')).toBeNull()
    expect(tabInstancePid('pty-')).toBeNull()
    expect(tabInstancePid('pty-0-1')).toBeNull()
  })
})

describe("BB-E27: a scheduled run's first prompt and session name reach only the tab that asked for them", () => {
  function envOf(call: number): Record<string, string> {
    return (mocks.spawn.mock.calls[call][2] as { env: Record<string, string> }).env
  }

  it('never lets an inherited first prompt or session name reach an ordinary tab', () => {
    process.env.KOLOFT_FIRST_PROMPT = '/oops'
    process.env.KOLOFT_SESSION_NAME = 'x'
    try {
      const mgr = new PtyManager()
      mgr.create({ kind: 'claude', cwd: os.tmpdir() })
      expect(spawnedEnv().KOLOFT_FIRST_PROMPT).toBeUndefined()
      expect(spawnedEnv().KOLOFT_SESSION_NAME).toBeUndefined()
    } finally {
      delete process.env.KOLOFT_FIRST_PROMPT
      delete process.env.KOLOFT_SESSION_NAME
    }
  })

  it('gives the asking tab those two keys and the next tab none of them', () => {
    const mgr = new PtyManager()
    mgr.create({
      kind: 'claude',
      cwd: os.tmpdir(),
      extraEnv: { KOLOFT_FIRST_PROMPT: '/daily-report', KOLOFT_SESSION_NAME: 'Nightly report' }
    })
    mgr.create({ kind: 'claude', cwd: os.tmpdir() })
    expect(envOf(0).KOLOFT_FIRST_PROMPT).toBe('/daily-report')
    expect(envOf(0).KOLOFT_SESSION_NAME).toBe('Nightly report')
    expect(envOf(1).KOLOFT_FIRST_PROMPT).toBeUndefined()
    expect(envOf(1).KOLOFT_SESSION_NAME).toBeUndefined()
  })

  it('ignores any other key someone puts in that object, so a PATH there cannot undo the shim line', () => {
    const mgr = new PtyManager()
    mgr.shimDir = '/koloft/shim'
    mgr.create({ kind: 'claude', cwd: os.tmpdir() })
    mgr.create({
      kind: 'claude',
      cwd: os.tmpdir(),
      extraEnv: {
        KOLOFT_FIRST_PROMPT: '/daily-report',
        PATH: '/somewhere/else',
        ANTHROPIC_API_KEY: 'sk-nope'
      } as { KOLOFT_FIRST_PROMPT?: string; KOLOFT_SESSION_NAME?: string }
    })
    expect(envOf(1).KOLOFT_FIRST_PROMPT).toBe('/daily-report')
    expect(envOf(1).PATH).toBe(envOf(0).PATH)
    expect(envOf(1).ANTHROPIC_API_KEY).toBeUndefined()
  })

  it('leaves PATH exactly as the tab would have had it', () => {
    const mgr = new PtyManager()
    mgr.shimDir = '/koloft/shim'
    mgr.create({ kind: 'claude', cwd: os.tmpdir() })
    mgr.create({
      kind: 'claude',
      cwd: os.tmpdir(),
      extraEnv: { KOLOFT_FIRST_PROMPT: '/daily-report' }
    })
    expect(envOf(1).PATH).toBe(envOf(0).PATH)
  })
})

describe('PtyManager utility-shell process title', () => {
  function titles(mgr: PtyManager): { id: string; name: string }[] {
    const seen: { id: string; name: string }[] = []
    mgr.on('process-title', (p: { id: string; name: string }) => seen.push(p))
    return seen
  }

  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('reports a utility shell’s foreground process as it changes', () => {
    const mgr = new PtyManager()
    const seen = titles(mgr)
    const h = mgr.create({ kind: 'shell', cwd: os.tmpdir(), util: true })
    mocks.state.processName = 'node'
    vi.advanceTimersByTime(2000)
    expect(seen).toEqual([{ id: h.id, name: 'node' }])
  })

  it('reports each name once — an idle shell is silent', () => {
    const mgr = new PtyManager()
    const seen = titles(mgr)
    mgr.create({ kind: 'shell', cwd: os.tmpdir(), util: true })
    vi.advanceTimersByTime(2000)
    vi.advanceTimersByTime(2000)
    expect(seen.map((t) => t.name)).toEqual(['zsh'])
  })

  it('reports the command name, never the spawn-file path node-pty falls back to', () => {
    const mgr = new PtyManager()
    const seen = titles(mgr)
    mocks.state.processName = '/bin/zsh'
    mgr.create({ kind: 'shell', cwd: os.tmpdir(), util: true })
    vi.advanceTimersByTime(2000)
    expect(seen.map((t) => t.name)).toEqual(['zsh'])
  })

  it('never polls a pty that is not a utility shell', () => {
    const mgr = new PtyManager()
    const seen = titles(mgr)
    mgr.create({ kind: 'claude', cwd: os.tmpdir() })
    mocks.state.processName = 'node'
    vi.advanceTimersByTime(10_000)
    expect(seen).toEqual([])
  })

  // PLATFORM§29
  it('survives a foreground-process read that answers undefined instead of crashing main from the poll timer', () => {
    const mgr = new PtyManager()
    const seen = titles(mgr)
    mgr.create({ kind: 'shell', cwd: os.tmpdir(), util: true })
    vi.advanceTimersByTime(2000)
    mocks.state.processName = undefined
    expect(() => vi.advanceTimersByTime(2000)).not.toThrow()
    expect(seen.map((t) => t.name)).toEqual(['zsh'])
    mocks.state.processName = 'node'
    vi.advanceTimersByTime(2000)
    expect(seen.map((t) => t.name)).toEqual(['zsh', 'node'])
  })

  it('stops polling once the shell exits', () => {
    const mgr = new PtyManager()
    const seen = titles(mgr)
    mgr.create({ kind: 'shell', cwd: os.tmpdir(), util: true })
    vi.advanceTimersByTime(2000)
    mocks.state.exit?.({ exitCode: 0 })
    mocks.state.processName = 'node'
    vi.advanceTimersByTime(10_000)
    expect(seen.map((t) => t.name)).toEqual(['zsh'])
  })
})

describe('PtyManager utility-shell cwd tracking (D13)', () => {
  function cwds(mgr: PtyManager): { id: string; cwd: string }[] {
    const seen: { id: string; cwd: string }[] = []
    mgr.on('cwd', (c: { id: string; cwd: string }) => seen.push(c))
    return seen
  }
  const report = (dir: string): string => `\x1b]7;file://${os.hostname()}${dir}\x07`

  it('reports a utility shell’s directory when its OSC 7 says it moved', () => {
    const mgr = new PtyManager()
    const seen = cwds(mgr)
    const h = mgr.create({ kind: 'shell', cwd: '/tmp', util: true })
    mocks.state.data?.(`$ cd /var/log\r\n${report('/var/log')}`)
    expect(seen).toEqual([{ id: h.id, cwd: '/var/log' }])
    expect(mgr.get(h.id)?.cwd).toBe('/var/log')
  })

  it('stays silent while the shell keeps reporting the directory it is already in', () => {
    const mgr = new PtyManager()
    const seen = cwds(mgr)
    const h = mgr.create({ kind: 'shell', cwd: '/tmp', util: true })
    mocks.state.data?.(report('/tmp'))
    mocks.state.data?.(report('/tmp'))
    expect(seen).toEqual([])
    mocks.state.data?.(report('/tmp/sub'))
    expect(seen).toEqual([{ id: h.id, cwd: '/tmp/sub' }])
  })

  it('reassembles a report torn across two pty chunks', () => {
    const mgr = new PtyManager()
    const seen = cwds(mgr)
    mgr.create({ kind: 'shell', cwd: '/tmp', util: true })
    const whole = report('/tmp/torn')
    mocks.state.data?.(whole.slice(0, 12))
    expect(seen).toEqual([])
    mocks.state.data?.(whole.slice(12))
    expect(seen.map((c) => c.cwd)).toEqual(['/tmp/torn'])
  })

  it('never tracks a pty that is not a utility shell', () => {
    const mgr = new PtyManager()
    const seen = cwds(mgr)
    mgr.create({ kind: 'claude', cwd: '/tmp' })
    mocks.state.data?.(report('/var/log'))
    expect(seen).toEqual([])
  })

  it('still forwards the raw data it parsed', () => {
    const mgr = new PtyManager()
    const chunks: string[] = []
    mgr.on('data', (d: { data: string }) => chunks.push(d.data))
    mgr.create({ kind: 'shell', cwd: '/tmp', util: true })
    const chunk = `ls\r\n${report('/tmp/x')}`
    mocks.state.data?.(chunk)
    expect(chunks).toEqual([chunk])
  })
})

describe("foregroundName: node-pty's report is untrusted input whatever its typing claims", () => {
  it('reduces a reported path to its command name', () => {
    expect(foregroundName('node')).toBe('node')
    expect(foregroundName('/bin/zsh')).toBe('zsh')
    expect(foregroundName('/usr/local/bin/npm')).toBe('npm')
  })

  it('answers null for anything that is not a usable name', () => {
    expect(foregroundName(undefined)).toBeNull()
    expect(foregroundName(null)).toBeNull()
    expect(foregroundName('')).toBeNull()
    expect(foregroundName('/')).toBeNull()
    expect(foregroundName('/bin/')).toBeNull()
    expect(foregroundName(42)).toBeNull()
  })
})

describe('Codex native terminal isolation', () => {
  it('spawns the native binary with argv and gives it no Claude Workbench or account injection', () => {
    const mgr = new PtyManager()
    mgr.shimDir = '/koloft/shim'
    mgr.regDir = '/koloft/register'
    mgr.openDir = '/koloft/open'
    mgr.pickDir = '/koloft/accounts'
    mgr.cdpDir = '/koloft/cdp'
    const hooks = vi.fn(() => '/koloft/hooks')
    mgr.makeHookSettings = hooks
    const originalHome = process.env.CODEX_HOME
    process.env.CODEX_HOME = '/chosen/codex/config'
    try {
      mgr.create({
        kind: 'codex',
        cwd: '/repo',
        executable: '/bin/codex',
        argv: ['--remote', 'unix:///private/session.sock']
      })
      const [binary, args, options] = mocks.spawn.mock.calls[0] as [
        string,
        string[],
        { env: Record<string, string> }
      ]
      expect(binary).toBe('/bin/codex')
      expect(args).toEqual(['--remote', 'unix:///private/session.sock'])
      expect(hooks).not.toHaveBeenCalled()
      expect(Object.keys(options.env).filter((k) => k.startsWith('KOLOFT_'))).toEqual([])
      expect(options.env.CODEX_HOME).toBe('/chosen/codex/config')
      expect(options.env.PATH?.split(':')).not.toContain(mgr.shimDir)
    } finally {
      if (originalHome === undefined) delete process.env.CODEX_HOME
      else process.env.CODEX_HOME = originalHome
    }
  })
})
