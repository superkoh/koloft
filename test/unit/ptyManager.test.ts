import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import os from 'os'

// node-pty is a native addon built for Electron's ABI (npm run rebuild), so it can't
// load under plain-node vitest — and we don't need a real pty anyway. Mock spawn and
// capture the env it was handed, so we can assert the (critical, otherwise-untested)
// per-tab environment scrubbing without spawning anything.
const mocks = vi.hoisted(() => {
  // the foreground process name node-pty reports (`.process`) and the data / exit
  // callbacks the manager registers — all here so a test can drive them like a real
  // shell would
  // `processName` is deliberately `unknown`: node-pty TYPES `.process` as `string`,
  // but on macOS it is a native read of the tty's foreground process and answers
  // `undefined` in the gap between two commands (unixTerminal's darwin branch has no
  // `|| this._file` fallback). A mock that cannot lie the same way cannot reach the
  // poll's real hazard.
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

import { PtyManager, foregroundName } from '../../src/main/ptyManager'

const POLLUTANTS = {
  CLAUDE_CODE_ENTRYPOINT: 'cli',
  CLAUDECODE: '1',
  CLAUDE_EFFORT: 'high',
  AI_AGENT: '1',
  TERM_SESSION_ID: 'w0t1p0:ABC'
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
  // remove any locale so the UTF-8 fallback branch is exercised deterministically
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
  it('strips inherited CLAUDE_CODE_* / CLAUDECODE / CLAUDE_EFFORT / AI_AGENT / TERM_SESSION_ID', () => {
    const mgr = new PtyManager()
    mgr.create({ kind: 'shell', cwd: os.tmpdir() })
    const env = spawnedEnv()
    for (const k of Object.keys(POLLUTANTS)) expect(env[k]).toBeUndefined()
    // nothing CLAUDE_CODE_-prefixed survives
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
    // the open shim's is-my-Koloft-still-alive gate (kill -0) checks this pid
    expect(env.KOLOFT_PID).toBe(String(process.pid))
    expect(env.KOLOFT_HOOK_SETTINGS).toBe(`/koloft/hooks/${handle.id}.json`)
    // impersonate Apple Terminal for the OSC 7 cwd report
    expect(env.TERM_PROGRAM).toBe('Apple_Terminal')
  })

  // §06/D8: the shim's hard block keys off KOLOFT_UTIL, so the variable must mark utility
  // shells and ONLY utility shells — a session's own claude pty carrying it would be
  // blocked from starting at all (T-BLK-03's product premise).
  it('marks a global-terminal (utility) shell with KOLOFT_UTIL=1', () => {
    const mgr = new PtyManager()
    mgr.create({ kind: 'shell', cwd: os.tmpdir(), util: true })
    const env = spawnedEnv()
    expect(env.KOLOFT_UTIL).toBe('1')
    expect(env.KOLOFT_AUX).toBeUndefined() // the former name is not written alongside it
  })

  it('never leaks KOLOFT_UTIL into a session pty, even when Koloft itself inherited one', () => {
    process.env.KOLOFT_UTIL = '1' // Koloft launched from inside someone's terminal tab
    try {
      const mgr = new PtyManager()
      mgr.create({ kind: 'claude', cwd: os.tmpdir() })
      expect(spawnedEnv().KOLOFT_UTIL).toBeUndefined()
    } finally {
      delete process.env.KOLOFT_UTIL
    }
  })

  // KOLOFT_AUX / KOLOFT_AUX_TITLE named the former aux terminal. Nothing reads them any
  // more, but an older Koloft in the ancestry still exports them, and a marker whose
  // meaning has changed under it is exactly what must not travel into a fresh tab.
  it('strips the retired aux markers rather than passing them down', () => {
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

  // §06 (D8 re-review revisions 3 and 4, amended): a utility shell is cut off from what binds
  // a shell to a SESSION — registration (a `claude -p` there would grow a ghost sidebar
  // row) and the per-tab hook settings behind it. `open` interception is NOT in that
  // set: it binds a target to a surface, not a shell to a session, and a shell is
  // the user's own hands, so its opens land in Koloft like every other user open.
  it('withholds the session-bound env from a utility shell, keeping the rest', () => {
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

  // Multi-account balancing hands each launch its own credential, but the shim yields to
  // an auth token already in the env (nested calls / external wrappers must keep working).
  // So an ambient ANTHROPIC_* export in the launching shell would silently disable
  // balancing in EVERY tab — the whole feature off, with only a stderr line to say so.
  // Exports from an rc file can't be reached; what Koloft inherited at launch can.
  it('drops an inherited ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN while balancing is on', () => {
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

  // …and with the mode OFF they are the user's own auth: Koloft has no account to put in
  // their place, so stripping them would leave `claude` unauthenticated in every tab.
  it('keeps them when balancing is off', () => {
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

  // D9: a utility shell is never handed a browser endpoint. The shim exports one into
  // every session it starts, so a shell inside a Koloft session that then launches Koloft
  // (`npm run dev`, or the e2e suite) passes the PARENT instance's endpoint down — and an
  // inherited copy can never be right: it points at another instance's browser.
  it('never lets an inherited browser endpoint reach a utility shell', () => {
    process.env.KOLOFT_CDP_DIR = '/parent/koloft/cdp'
    process.env.KOLOFT_BROWSER_CDP = 'ws://127.0.0.1:9999/cdp/' + 'a'.repeat(32)
    process.env.PLAYWRIGHT_MCP_CDP_ENDPOINT = process.env.KOLOFT_BROWSER_CDP
    try {
      const mgr = new PtyManager()
      mgr.create({ kind: 'shell', cwd: os.tmpdir(), util: true })
      const env = spawnedEnv()
      expect(env.KOLOFT_CDP_DIR).toBeUndefined()
      expect(env.KOLOFT_BROWSER_CDP).toBeUndefined()
      expect(env.PLAYWRIGHT_MCP_CDP_ENDPOINT).toBeUndefined()
    } finally {
      delete process.env.KOLOFT_CDP_DIR
      delete process.env.KOLOFT_BROWSER_CDP
      delete process.env.PLAYWRIGHT_MCP_CDP_ENDPOINT
    }
  })

  it('forces a UTF-8 locale when none is inherited', () => {
    const mgr = new PtyManager()
    mgr.create({ kind: 'shell', cwd: os.tmpdir() })
    expect(spawnedEnv().LANG).toBe('en_US.UTF-8')
  })
})

// BB-E27 (§4.8): a scheduled run's first message travels as KOLOFT_FIRST_PROMPT,
// and the shim types it into the fresh session. That makes the variable dangerous in two
// directions: an INHERITED one (Koloft started from inside a scheduled run's own session)
// would make every ordinary new tab send somebody else's task by itself, and a value
// left behind on the manager would do the same to the next tab.
describe('PtyManager per-tab environment', () => {
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

  // the TYPE allows only those two keys, but the object comes off a caller the compiler
  // never saw — a hand-edited store, a future call site — so the merge names them rather
  // than looping. PATH is the sharp case: set here it would land AFTER the shim line and
  // undo it, taking the account balancer with it.
  it('ignores any other key someone puts in that object', () => {
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

  // the merge happens last, after the shim dir is put in front of PATH — so it must add
  // to the env, never rebuild it
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

// R19: a terminal tab is labelled with its shell's foreground process, and node-pty
// exposes that only as a getter — so main polls it. Everything downstream (the
// renderer's follow/pin rule) is fed by these events; an e2e that sees a stale label
// cannot say whether main polled the wrong ptys, never stopped, or never emitted.
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

  // node-pty falls back to the spawn file when the tty has no readable foreground
  // process — a tab must never be labelled `/bin/zsh`
  it('reports the command name, not a path', () => {
    const mgr = new PtyManager()
    const seen = titles(mgr)
    mocks.state.processName = '/bin/zsh'
    mgr.create({ kind: 'shell', cwd: os.tmpdir(), util: true })
    vi.advanceTimersByTime(2000)
    expect(seen.map((t) => t.name)).toEqual(['zsh'])
  })

  // a session's own pty is a claude TUI whose title comes from the transcript, and the
  // e2e seam's shell has no tab strip of its own — polling either is pure waste
  it('never polls a pty that is not a utility shell', () => {
    const mgr = new PtyManager()
    const seen = titles(mgr)
    mgr.create({ kind: 'claude', cwd: os.tmpdir() })
    mocks.state.processName = 'node'
    vi.advanceTimersByTime(10_000)
    expect(seen).toEqual([])
  })

  // node-pty's `.process` does not throw when the foreground process is unreadable —
  // on macOS it hands back `undefined`, which a `try/catch` cannot see. The poll lives
  // in a setInterval, so a TypeError there is an UNCAUGHT exception in the main
  // process: Electron's crash dialog, re-raised every 1500ms until the tab is closed
  // (v0.16.2). Any command that cycles the foreground fast (`a | b | c`, a seq loop)
  // lands in that gap within seconds.
  it('survives a foreground-process read that answers undefined', () => {
    const mgr = new PtyManager()
    const seen = titles(mgr)
    mgr.create({ kind: 'shell', cwd: os.tmpdir(), util: true })
    vi.advanceTimersByTime(2000)
    mocks.state.processName = undefined
    expect(() => vi.advanceTimersByTime(2000)).not.toThrow()
    expect(seen.map((t) => t.name)).toEqual(['zsh'])
    // an unreadable tick is a GAP, not a state: the next command still labels the tab
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

// R19: a terminal tab's live directory. The parser itself is covered in oscCwd.test;
// what this pins is the wiring — which ptys are watched, that the handle follows the
// shell, and that an idle prompt (which re-reports the SAME directory on every single
// command) does not turn into a layout write per keystroke.
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
    mocks.state.data?.(report('/tmp')) // the prompt hook fires on EVERY command
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

  // a claude TUI floods the stream with escape sequences and never reports a cwd —
  // scanning it would be pure waste, and its tab's directory is the session's, fixed
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

// The value half of the poll, split out so the hazard is testable at the only place it
// exists: what node-pty reports is untrusted input, whatever its typing claims. `null`
// means "this tick cannot name the process" — not a title, and not an error either.
describe('foregroundName', () => {
  it('reduces a reported path to its command name', () => {
    expect(foregroundName('node')).toBe('node')
    expect(foregroundName('/bin/zsh')).toBe('zsh')
    expect(foregroundName('/usr/local/bin/npm')).toBe('npm')
  })

  it('answers null for anything that is not a usable name', () => {
    expect(foregroundName(undefined)).toBeNull() // the macOS hand-over gap
    expect(foregroundName(null)).toBeNull()
    expect(foregroundName('')).toBeNull()
    expect(foregroundName('/')).toBeNull() // basename of a bare slash is empty
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
      // by entry, not substring: this machine's own PATH may hold an installed
      // Koloft's ".../Application Support/koloft/shim"
      expect(options.env.PATH?.split(':')).not.toContain(mgr.shimDir)
    } finally {
      if (originalHome === undefined) delete process.env.CODEX_HOME
      else process.env.CODEX_HOME = originalHome
    }
  })
})
