import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { spawn, spawnSync } from 'child_process'

vi.mock('electron', async () => {
  const nfs = await import('node:fs')
  const nos = await import('node:os')
  const npath = await import('node:path')
  const base = nfs.mkdtempSync(npath.join(nos.tmpdir(), 'koloft-shim-'))
  return { app: { getPath: () => base, getName: () => 'koloft-dev', isPackaged: false } }
})

import { setupShim } from '../../src/main/shim'

let shimDir: string
let regDir: string
let pickDir: string
let base: string
let realBin: string
let fakeKeychainDir: string

beforeAll(() => {
  ;({ shimDir, regDir, pickDir } = setupShim())
  base = path.dirname(shimDir)
  realBin = fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-realbin-'))
  fs.writeFileSync(
    path.join(realBin, 'claude'),
    '#!/usr/bin/env bash\nprintf "%s\\n" "$@" > "$KOLOFT_ARGS_OUT"\n' +
      'if [ -n "$KOLOFT_ARGS0_OUT" ]; then : > "$KOLOFT_ARGS0_OUT"\n' +
      '  for a in "$@"; do printf "%s\\0" "$a" >> "$KOLOFT_ARGS0_OUT"; done\nfi\n' +
      '[ -n "$KOLOFT_ENV_OUT" ] && env > "$KOLOFT_ENV_OUT"\nexit 0\n',
    { mode: 0o755 }
  )
  fs.chmodSync(path.join(realBin, 'claude'), 0o755)
  fakeKeychainDir = fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-fakekc-'))
  fs.writeFileSync(
    path.join(realBin, 'security'),
    '#!/usr/bin/env bash\nacct=""; svc=""; prev=""\n' +
      'for a in "$@"; do [ "$prev" = "-a" ] && acct="$a"; [ "$prev" = "-s" ] && svc="$a"; prev="$a"; done\n' +
      'case "$svc" in koloft-dev-*) ;; *) exit 44;; esac\n' +
      'if [ -n "$KOLOFT_FAKE_SECURITY_HANG" ]; then echo $$ > "$KOLOFT_FAKE_KEYCHAIN_DIR/.hangpid"; sleep 30; exit 0; fi\n' +
      'f="$KOLOFT_FAKE_KEYCHAIN_DIR/$acct"\n' +
      '[ -f "$f" ] && cat "$f" && exit 0\nexit 44\n',
    { mode: 0o755 }
  )
  fs.chmodSync(path.join(realBin, 'security'), 0o755)
})

afterAll(() => {
  fs.rmSync(base, { recursive: true, force: true })
  fs.rmSync(realBin, { recursive: true, force: true })
  fs.rmSync(fakeKeychainDir, { recursive: true, force: true })
})

beforeEach(() => {
  for (const d of [regDir, pickDir, fakeKeychainDir]) {
    for (const f of fs.readdirSync(d)) fs.rmSync(path.join(d, f), { force: true, recursive: true })
  }
})

interface ShimRun {
  reg: { tabId: string; sessionId: string; mode: string; cwd: string } | null
  realArgs: string[] | null
  realArgs0: string[] | null
  realEnv: Record<string, string> | null
  stderr: string
  status: number
}

function pinnedShimEnvNeverSpreadingProcessEnv(
  cwd: string,
  argsOut: string,
  envOut: string,
  extra: Record<string, string>
): NodeJS.ProcessEnv {
  return {
    PATH: `${shimDir}:${realBin}:/usr/bin:/bin`,
    HOME: os.homedir(),
    PWD: cwd,
    KOLOFT_TAB_ID: 'tab-shim',
    KOLOFT_SESSION_DIR: regDir,
    KOLOFT_HOOK_SETTINGS: '/tmp/koloft-hooks.json',
    KOLOFT_ARGS_OUT: argsOut,
    KOLOFT_ARGS0_OUT: `${argsOut}.0`,
    KOLOFT_ENV_OUT: envOut,
    KOLOFT_FAKE_KEYCHAIN_DIR: fakeKeychainDir,
    ...extra
  }
}

function collect(
  cwd: string,
  argsOut: string,
  envOut: string,
  status: number,
  stderr: string
): ShimRun {
  const regFiles = fs.readdirSync(regDir).filter((f) => f.endsWith('.json'))
  const reg = regFiles.length
    ? JSON.parse(fs.readFileSync(path.join(regDir, regFiles[0]), 'utf8'))
    : null
  const realArgs = fs.existsSync(argsOut)
    ? fs.readFileSync(argsOut, 'utf8').split('\n').filter(Boolean)
    : null
  let realArgs0: string[] | null = null
  if (fs.existsSync(`${argsOut}.0`)) {
    realArgs0 = fs.readFileSync(`${argsOut}.0`, 'utf8').split('\0')
    realArgs0.pop()
  }
  let realEnv: Record<string, string> | null = null
  if (fs.existsSync(envOut)) {
    realEnv = {}
    for (const line of fs.readFileSync(envOut, 'utf8').split('\n')) {
      const i = line.indexOf('=')
      if (i > 0) realEnv[line.slice(0, i)] = line.slice(i + 1)
    }
  }
  return { reg, realArgs, realArgs0, realEnv, stderr, status }
}

function runShim(args: string[], extraEnv: Record<string, string> = {}): ShimRun {
  const cwd = os.tmpdir()
  const argsOut = path.join(base, `args-${Math.random().toString(36).slice(2)}`)
  const envOut = path.join(base, `env-${Math.random().toString(36).slice(2)}`)
  const res = spawnSync(path.join(shimDir, 'claude'), args, {
    cwd,
    env: pinnedShimEnvNeverSpreadingProcessEnv(cwd, argsOut, envOut, extraEnv),
    encoding: 'utf8',
    timeout: 15_000
  })
  return collect(cwd, argsOut, envOut, res.status ?? -1, res.stderr ?? '')
}

function runShimPick(
  args: string[],
  answer: Record<string, unknown>,
  extraEnv: Record<string, string> = {}
): Promise<ShimRun> {
  const cwd = os.tmpdir()
  const argsOut = path.join(base, `args-${Math.random().toString(36).slice(2)}`)
  const envOut = path.join(base, `env-${Math.random().toString(36).slice(2)}`)
  const env = pinnedShimEnvNeverSpreadingProcessEnv(cwd, argsOut, envOut, {
    KOLOFT_PICK_DIR: pickDir,
    KOLOFT_PID: String(process.pid),
    ...extraEnv
  })
  const responder = setInterval(() => {
    const req = fs.readdirSync(pickDir).find((f) => f.startsWith('req-') && f.endsWith('.json'))
    if (!req) return
    clearInterval(responder)
    const id = req.slice('req-'.length, -'.json'.length)
    const resPath = path.join(pickDir, `res-${id}.json`)
    fs.writeFileSync(`${resPath}.tmp`, JSON.stringify(answer))
    fs.renameSync(`${resPath}.tmp`, resPath)
  }, 20)
  return new Promise((resolve) => {
    const child = spawn(path.join(shimDir, 'claude'), args, { cwd, env })
    let stderr = ''
    child.stderr.on('data', (c) => (stderr += c))
    child.on('close', (status) => {
      clearInterval(responder)
      resolve(collect(cwd, argsOut, envOut, status ?? -1, stderr))
    })
  })
}

describe('claude shim (registration — unchanged behavior)', () => {
  it('new interactive launch injects --session-id + --settings and registers mode "new"', () => {
    const { reg, realArgs } = runShim([])
    expect(reg?.mode).toBe('new')
    expect(reg?.tabId).toBe('tab-shim')
    expect(reg?.sessionId).toMatch(/^[0-9a-f-]{36}$/)
    expect(realArgs).toContain('--session-id')
    expect(realArgs).toContain(reg!.sessionId)
    expect(realArgs).toContain('--settings')
    expect(realArgs).toContain('/tmp/koloft-hooks.json')
  })

  it('--resume <id> registers mode "exact" with that id and does NOT inject --session-id', () => {
    const sid = 'abcdef01-2345-4678-8abc-def012345678'
    const { reg, realArgs } = runShim(['--resume', sid])
    expect(reg?.mode).toBe('exact')
    expect(reg?.sessionId).toBe(sid)
    expect(realArgs).not.toContain('--session-id')
    expect(realArgs).toContain('--settings')
    expect(realArgs).toContain('--resume')
  })

  it('--resume without an id registers mode "resume" with empty id', () => {
    const { reg, realArgs } = runShim(['--resume'])
    expect(reg?.mode).toBe('resume')
    expect(reg?.sessionId).toBe('')
    expect(realArgs).toContain('--settings')
  })

  it('-p (print/headless) is passed through untouched: no registration, no --settings', () => {
    const { reg, realArgs } = runShim(['-p', 'hello'])
    expect(reg).toBeNull()
    expect(realArgs).toEqual(['-p', 'hello'])
  })

  it('subcommands (mcp) are passed through untouched', () => {
    const { reg, realArgs } = runShim(['mcp', 'list'])
    expect(reg).toBeNull()
    expect(realArgs).toEqual(['mcp', 'list'])
  })
})

describe('claude shim (multi-account pick section — U5)', () => {
  const token = (name: string, tok: string): void => {
    fs.writeFileSync(path.join(fakeKeychainDir, name), tok)
  }

  const CAPPED_NOT_HUNG_BOUND_FOR_A_SLOW_CI_RUNNER_MS = 25_000

  // PLATFORM§3
  it('a HANGING Keychain read degrades inside the ~5s cap, then launches unauthenticated — a locked keychain must never hang every launch', async () => {
    token('bravo', 'tok-never-read')
    const t0 = Date.now()
    const r = await runShimPick(
      [],
      { account: 'bravo', kind: 'oauth', banner: 'koloft: bravo' },
      { KOLOFT_FAKE_SECURITY_HANG: '1' }
    )
    const elapsed = Date.now() - t0
    expect(elapsed).toBeGreaterThan(4_000)
    expect(elapsed).toBeLessThan(CAPPED_NOT_HUNG_BOUND_FOR_A_SLOW_CI_RUNNER_MS)
    expect(r.stderr).toContain('no credential for bravo')
    expect(r.realArgs).not.toBeNull()
    expect(r.realEnv?.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined()
  }, 30_000)

  // PLATFORM§2
  it('leaves no orphaned `security` behind after giving up, still holding the dialog that blocked the launch', async () => {
    token('bravo', 'tok-never-read')
    await runShimPick(
      [],
      { account: 'bravo', kind: 'oauth', banner: 'koloft: bravo' },
      { KOLOFT_FAKE_SECURITY_HANG: '1' }
    )
    const pidFile = path.join(fakeKeychainDir, '.hangpid')
    expect(fs.existsSync(pidFile)).toBe(true)
    const pid = Number(fs.readFileSync(pidFile, 'utf8').trim())
    let alive = true
    try {
      process.kill(pid, 0)
    } catch {
      alive = false
    }
    if (alive) process.kill(pid, 'SIGKILL')
    expect(alive).toBe(false)
  }, 30_000)

  it("bakes THIS build's Keychain namespace into all three service names — the shim resolves it alone, and a drift would read another build's store", () => {
    const script = fs.readFileSync(path.join(shimDir, 'claude'), 'utf8')
    expect(script).toContain('psvc="koloft-dev-claude-oauth"')
    expect(script).toContain('psvc="koloft-dev-anthropic-api"')
    expect(script).toContain('psvc="koloft-dev-custom-endpoint"')
    expect(script).not.toContain('__KOLOFT_KEYCHAIN_NS__')
    expect(script).not.toContain('"koloft-claude-oauth"')
  })

  it('wrapper respect: pre-existing token env → no req file, env untouched, warning when mode on', () => {
    const r = runShim([], {
      CLAUDE_CODE_OAUTH_TOKEN: 'wrapper-tok',
      KOLOFT_PICK_DIR: pickDir,
      KOLOFT_PID: String(process.pid),
      KOLOFT_MULTI_ACCOUNT: '1'
    })
    expect(fs.readdirSync(pickDir)).toHaveLength(0)
    expect(r.realEnv?.CLAUDE_CODE_OAUTH_TOKEN).toBe('wrapper-tok')
    expect(r.stderr).toContain('skipping balancing')
  })

  it('wrapper respect without mode: same passthrough, NO warning line', () => {
    const r = runShim([], {
      ANTHROPIC_API_KEY: 'ambient-key',
      KOLOFT_PICK_DIR: pickDir,
      KOLOFT_PID: String(process.pid)
    })
    expect(fs.readdirSync(pickDir)).toHaveLength(0)
    expect(r.realEnv?.ANTHROPIC_API_KEY).toBe('ambient-key')
    expect(r.stderr).not.toContain('skipping balancing')
  })

  it('no KOLOFT_PICK_DIR (no watcher) → bare exec, no pick attempted', () => {
    const r = runShim([])
    expect(r.realEnv?.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined()
    expect(r.stderr).not.toContain('koloft:')
  })

  it('Koloft dead (stale KOLOFT_PID) → instant bare exec, no 3s wait', () => {
    const t0 = Date.now()
    const r = runShim([], { KOLOFT_PICK_DIR: pickDir, KOLOFT_PID: '999999' })
    expect(Date.now() - t0).toBeLessThan(2500)
    expect(fs.readdirSync(pickDir)).toHaveLength(0)
    expect(r.realEnv?.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined()
  })

  it('normal oauth injection: env + the ANT_ACCOUNT tag the statusline reads + banner format + flag BEFORE user args + cleanup', async () => {
    token('bravo', 'sk-ant-oat01-bravo-fixture')
    const r = await runShimPick(['--verbose'], {
      account: 'bravo',
      kind: 'oauth',
      banner: 'koloft: → bravo · 5h 33% · 7d 52% · fable 34%',
      skipFlag: true
    })
    expect(r.realEnv?.CLAUDE_CODE_OAUTH_TOKEN).toBe('sk-ant-oat01-bravo-fixture')
    expect(r.realEnv?.ANTHROPIC_API_KEY).toBeUndefined()
    expect(r.stderr).toContain('koloft: → bravo · 5h 33% · 7d 52% · fable 34%')
    expect(r.realEnv?.ANT_ACCOUNT).toBe('bravo')
    const args = r.realArgs ?? []
    expect(args.indexOf('--dangerously-skip-permissions')).toBeLessThan(args.indexOf('--verbose'))
    expect(fs.readdirSync(pickDir)).toHaveLength(0)
  })

  it('the fable-exhausted warning prints as its OWN stderr line, never a literal \\n at the end of the banner', async () => {
    token('alpha', 'sk-ant-oat01-alpha-fixture')
    const r = await runShimPick([], {
      account: 'alpha',
      kind: 'oauth',
      banner: 'koloft: → alpha · 5h 20% · 7d 61%',
      warning:
        'koloft: every account is out of fable — running fable now counts against usage credits'
    })
    const lines = r.stderr.split('\n').filter((l) => l.startsWith('koloft:'))
    expect(lines).toContain('koloft: → alpha · 5h 20% · 7d 61%')
    expect(lines).toContain(
      'koloft: every account is out of fable — running fable now counts against usage credits'
    )
    expect(r.stderr).not.toContain('\\n')
  })

  it('no warning key → no second line (fable route stays a one-liner)', async () => {
    token('bravo', 'sk-ant-oat01-bravo-fixture')
    const r = await runShimPick([], {
      account: 'bravo',
      kind: 'oauth',
      banner: 'koloft: → bravo · 5h 33% · 7d 52% · fable 34%'
    })
    expect(r.stderr.split('\n').filter((l) => l.startsWith('koloft:'))).toHaveLength(1)
  })

  it('apikey injection exports ANTHROPIC_API_KEY and unsets the oauth var', async () => {
    token('api-main', 'sk-ant-api03-fixture')
    const r = await runShimPick([], {
      account: 'api-main',
      kind: 'apikey',
      banner: 'koloft: → api-main (API key, metered)'
    })
    expect(r.realEnv?.ANTHROPIC_API_KEY).toBe('sk-ant-api03-fixture')
    expect(r.realEnv?.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined()
    expect(r.realEnv?.ANT_ACCOUNT).toBe('api-main')
    expect(r.stderr).toContain('metered')
  })

  it("custom endpoint injects BASE_URL + AUTH_TOKEN, pins every model slot to the endpoint's model and clears the native credentials", async () => {
    token('glm', 'endpoint-key-fixture')
    const r = await runShimPick([], {
      account: 'glm',
      kind: 'custom',
      banner: 'koloft: → glm (custom endpoint · glm-5.2)',
      baseUrl: 'https://example.test/api/anthropic',
      model: 'glm-5.2'
    })
    expect(r.realEnv?.ANTHROPIC_AUTH_TOKEN).toBe('endpoint-key-fixture')
    expect(r.realEnv?.ANTHROPIC_BASE_URL).toBe('https://example.test/api/anthropic')
    expect(r.realEnv?.ANTHROPIC_MODEL).toBe('glm-5.2')
    expect(r.realEnv?.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('glm-5.2')
    expect(r.realEnv?.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('glm-5.2')
    expect(r.realEnv?.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('glm-5.2')
    expect(r.realEnv?.ANTHROPIC_DEFAULT_FABLE_MODEL).toBe('glm-5.2')
    expect(r.realEnv?.CLAUDE_CODE_SUBAGENT_MODEL).toBe('glm-5.2')
    expect(r.realEnv?.CLAUDE_CODE_SUBAGENT_MODEL_FORCE).toBe('1')
    expect(r.realEnv?.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined()
    expect(r.realEnv?.ANTHROPIC_API_KEY).toBeUndefined()
  })

  it('custom endpoint without a model override leaves the model slots alone', async () => {
    token('proxy', 'proxy-key')
    const r = await runShimPick([], {
      account: 'proxy',
      kind: 'custom',
      banner: 'koloft: → proxy (custom endpoint)',
      baseUrl: 'https://proxy.test'
    })
    expect(r.realEnv?.ANTHROPIC_BASE_URL).toBe('https://proxy.test')
    expect(r.realEnv?.ANTHROPIC_MODEL).toBeUndefined()
    expect(r.realEnv?.CLAUDE_CODE_SUBAGENT_MODEL_FORCE).toBeUndefined()
  })

  it('-p gets the token but NEVER the flag, and still does not register', async () => {
    token('bravo', 'tok-bravo')
    const r = await runShimPick(['-p', 'hi'], {
      account: 'bravo',
      kind: 'oauth',
      banner: '',
      skipFlag: true
    })
    expect(r.reg).toBeNull()
    expect(r.realEnv?.CLAUDE_CODE_OAUTH_TOKEN).toBe('tok-bravo')
    expect(r.realArgs).toEqual(['-p', 'hi'])
  })

  it('setup-token (the login flow) is NEVER injected and never asks for a pick', () => {
    token('bravo', 'tok-bravo')
    const r = runShim(['setup-token'], {
      KOLOFT_PICK_DIR: pickDir,
      KOLOFT_PID: String(process.pid)
    })
    expect(fs.readdirSync(pickDir)).toHaveLength(0)
    expect(r.realEnv?.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined()
  })

  it('explicit --permission-mode wins: token injected, flag NOT appended', async () => {
    token('bravo', 'tok-bravo')
    const r = await runShimPick(['--permission-mode', 'plan'], {
      account: 'bravo',
      kind: 'oauth',
      banner: 'koloft: → bravo',
      skipFlag: true
    })
    expect(r.realEnv?.CLAUDE_CODE_OAUTH_TOKEN).toBe('tok-bravo')
    expect(r.realArgs).not.toContain('--dangerously-skip-permissions')
    expect(r.realArgs).toContain('plan')
  })

  it('skipFlag absent (setting off) → token injected without the flag', async () => {
    token('bravo', 'tok-bravo')
    const r = await runShimPick([], { account: 'bravo', kind: 'oauth', banner: 'koloft: → bravo' })
    expect(r.realEnv?.CLAUDE_CODE_OAUTH_TOKEN).toBe('tok-bravo')
    expect(r.realArgs).not.toContain('--dangerously-skip-permissions')
  })

  it('res timeout → bare exec + explanation line + req best-effort removed', () => {
    const t0 = Date.now()
    const r = runShim([], { KOLOFT_PICK_DIR: pickDir, KOLOFT_PID: String(process.pid) })
    const elapsed = Date.now() - t0
    expect(elapsed).toBeGreaterThan(2500)
    expect(r.realEnv?.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined()
    expect(r.stderr).toContain('timed out')
    expect(fs.readdirSync(pickDir).filter((f) => f.startsWith('req-'))).toHaveLength(0)
  }, 15_000)

  it('missing keychain entry → bare exec with explanation, claude still launches', async () => {
    const r = await runShimPick([], { account: 'ghost', kind: 'oauth', banner: 'koloft: → ghost' })
    expect(r.realEnv?.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined()
    expect(r.stderr).toContain('no credential for')
    expect(r.realArgs).not.toBeNull()
  })

  it('reason no-accounts → bare exec + default-login line', async () => {
    const r = await runShimPick([], { account: null, reason: 'no-accounts' })
    expect(r.realEnv?.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined()
    expect(r.stderr).toContain('no usable account')
  })

  it('reason disabled → silent bare exec (mode off is not an anomaly)', async () => {
    const r = await runShimPick([], { account: null, reason: 'disabled' })
    expect(r.realEnv?.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined()
    expect(r.stderr).not.toContain('koloft:')
  })

  it('hostile account name in the res: quoted everywhere, no side effects, bare exec', async () => {
    const pwned = path.join(base, 'pwned-marker')
    const r = await runShimPick([], {
      account: `x;touch ${pwned}`,
      kind: 'oauth',
      banner: 'koloft: → x'
    })
    expect(fs.existsSync(pwned)).toBe(false)
    expect(r.realEnv?.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined()
    expect(r.status).toBe(0)
  })

  it('LEAK ASSERTION: the token never appears on the shim stdio (banner only)', async () => {
    token('bravo', 'sk-ant-oat01-NEVER-ON-STDIO')
    const r = await runShimPick([], {
      account: 'bravo',
      kind: 'oauth',
      banner: 'koloft: → bravo · 5h 1% · 7d 2%'
    })
    expect(r.realEnv?.CLAUDE_CODE_OAUTH_TOKEN).toBe('sk-ant-oat01-NEVER-ON-STDIO')
    expect(r.stderr).not.toContain('NEVER-ON-STDIO')
  })
})

describe('claude shim (Koloft terminal hard block — a product funnel, not a security boundary)', () => {
  const UTIL = { KOLOFT_UTIL: '1' }

  it("T-BLK-01 interactive launch → exit 1, funnel banner, real claude never exec'd", () => {
    const r = runShim([], UTIL)
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('⛔ Koloft — this is a Koloft terminal, not an agent surface.')
    expect(r.stderr).toContain("Start interactive Claude from the sidebar's ＋ (⌘N).")
    expect(r.stderr).toContain('Non-interactive use is fine: claude -p · --help · doctor · mcp · …')
    expect(r.realArgs).toBeNull()
    expect(r.reg).toBeNull()
  })

  it("the retired KOLOFT_AUX flag no longer blocks anything — a stale export must not block a session's own claude", () => {
    const r = runShim([], { KOLOFT_AUX: '1', KOLOFT_AUX_TITLE: 'somebody else’s session' })
    expect(r.status).toBe(0)
    expect(r.stderr).not.toContain('⛔')
    expect(r.reg?.mode).toBe('new')
  })

  it.each([
    [['--resume', 'abcdef01-2345-4678-8abc-def012345678']],
    [['-r']],
    [['explain this repo']]
  ])('T-BLK-01 interactive form %j is blocked, though it skips registration', (args) => {
    const r = runShim(args, UTIL)
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('⛔ Koloft')
    expect(r.realArgs).toBeNull()
  })

  it.each([
    [['-p', 'hi']],
    [['--print', 'hi']],
    [['-h']],
    [['--help']],
    [['--help-all']],
    [['-v']],
    [['--version']],
    [['doctor']],
    [['mcp', 'list']],
    [['config', 'get', 'theme']],
    [['auth']],
    [['setup-token']],
    [['agents']],
    [['project', 'purge']],
    [['update']],
    [['install']],
    [['plugin', 'list']],
    [['import']]
  ])('T-BLK-02 allow-list %j passes through untouched', (args) => {
    const r = runShim(args, UTIL)
    expect(r.status).toBe(0)
    expect(r.stderr).not.toContain('⛔')
    expect(r.realArgs).toEqual(args)
  })

  it('an allow-listed launch that would otherwise register writes nothing — a utility shell binds to no session', () => {
    const r = runShim(['--debug', 'agents'], UTIL)
    expect(r.status).toBe(0)
    expect(r.realArgs).toContain('agents')
    expect(r.reg).toBeNull()
    expect(fs.readdirSync(regDir).filter((f) => f.endsWith('.json'))).toEqual([])
  })

  it('T-BLK-03 (unit half) no KOLOFT_UTIL → nothing is intercepted', () => {
    const r = runShim([])
    expect(r.status).toBe(0)
    expect(r.stderr).not.toContain('⛔')
    expect(r.reg?.mode).toBe('new')
  })

  it('T-BLK-04 blocks BEFORE the account pick: no req file, no 3s wait', () => {
    const t0 = Date.now()
    const r = runShim([], { ...UTIL, KOLOFT_PICK_DIR: pickDir, KOLOFT_PID: String(process.pid) })
    expect(r.status).toBe(1)
    expect(Date.now() - t0).toBeLessThan(2500)
    expect(fs.readdirSync(pickDir)).toHaveLength(0)
    expect(r.stderr).not.toContain('timed out')
  })

  it('an allow-listed `-p` still gets a balanced account injected', async () => {
    fs.writeFileSync(path.join(fakeKeychainDir, 'bravo'), 'sk-ant-oat01-UTIL-P')
    const r = await runShimPick(
      ['-p', 'hi'],
      { account: 'bravo', kind: 'oauth', banner: 'koloft: → bravo' },
      UTIL
    )
    expect(r.status).toBe(0)
    expect(r.realArgs).toEqual(['-p', 'hi'])
    expect(r.realEnv?.CLAUDE_CODE_OAUTH_TOKEN).toBe('sk-ant-oat01-UTIL-P')
  }, 30_000)
})

describe('claude shim (scheduled jobs: first prompt + session name ride env vars, never the typed command line — BB-E19 / §4.6)', () => {
  const TASK = 'say "hi" $HOME \'there\'\nsecond line'
  const NAME = 'Nightly report'
  const CRON = { KOLOFT_FIRST_PROMPT: TASK, KOLOFT_SESSION_NAME: NAME }

  const norm = (r: ShimRun): string[] =>
    (r.realArgs0 ?? []).map((a) => (a === r.reg?.sessionId ? '<sid>' : a))

  it('BB-E19 the task text and name reach claude byte for byte, at the END of argv', () => {
    const r = runShim(['-w', 'n1'], CRON)
    expect(r.reg?.mode).toBe('new')
    expect(norm(r)).toEqual([
      '--settings',
      '/tmp/koloft-hooks.json',
      '--session-id',
      '<sid>',
      '-w',
      'n1',
      '--name',
      NAME,
      '--',
      TASK
    ])
    expect(r.realArgs0?.[r.realArgs0.length - 1]).toBe(TASK)
  })

  it('BB-E19 neither variable reaches the launched claude', () => {
    const r = runShim(['-w', 'n1'], CRON)
    expect(r.realEnv?.KOLOFT_FIRST_PROMPT).toBeUndefined()
    expect(r.realEnv?.KOLOFT_SESSION_NAME).toBeUndefined()
    expect(r.realArgs0).toContain(NAME)
  })

  it('BB-E19 `-w update` is a worktree name, not the `update` subcommand', () => {
    const r = runShim(['-w', 'update'], CRON)
    expect(r.reg?.mode).toBe('new')
    expect(norm(r)).toEqual([
      '--settings',
      '/tmp/koloft-hooks.json',
      '--session-id',
      '<sid>',
      '-w',
      'update',
      '--name',
      NAME,
      '--',
      TASK
    ])
  })

  // CC§9
  it('BB-E19 `-n update` is a session name, not the `update` subcommand', () => {
    const r = runShim(['-n', 'update'])
    expect(r.reg?.mode).toBe('new')
    expect(norm(r)).toEqual([
      '--settings',
      '/tmp/koloft-hooks.json',
      '--session-id',
      '<sid>',
      '-n',
      'update'
    ])
  })

  it('BB-E19 with both variables unset the argv is byte-identical to a plain launch', () => {
    const r = runShim(['-w', 'n1'])
    expect(norm(r)).toEqual([
      '--settings',
      '/tmp/koloft-hooks.json',
      '--session-id',
      '<sid>',
      '-w',
      'n1'
    ])
    expect(r.realArgs0).not.toContain('')
  })

  it('BB-E19 a resume carries neither `--` nor `--name`, and still registers "exact"', () => {
    const sid = 'abcdef01-2345-4678-8abc-def012345678'
    const r = runShim(['--resume', sid], CRON)
    expect(r.reg?.mode).toBe('exact')
    expect(r.reg?.sessionId).toBe(sid)
    expect(r.realArgs0).toEqual(['--settings', '/tmp/koloft-hooks.json', '--resume', sid])
    expect(r.realEnv?.KOLOFT_FIRST_PROMPT).toBeUndefined()
  })

  it('BB-E19 a print launch carries neither `--` nor `--name`', () => {
    const r = runShim(['-p', 'x'], CRON)
    expect(r.reg).toBeNull()
    expect(r.realArgs0).toEqual(['-p', 'x'])
    expect(r.realEnv?.KOLOFT_SESSION_NAME).toBeUndefined()
  })

  it("BB-E19 a `--model` value before the shim's tokens does not disturb registration", () => {
    const r = runShim(['--model', 'sonnet', '-w', 'n1'], CRON)
    expect(r.reg?.mode).toBe('new')
    expect(norm(r).slice(0, 6)).toEqual([
      '--settings',
      '/tmp/koloft-hooks.json',
      '--session-id',
      '<sid>',
      '--model',
      'sonnet'
    ])
  })

  it('BB-E19 `-w install` still gets an account injected (the value is not `install`)', async () => {
    fs.writeFileSync(path.join(fakeKeychainDir, 'bravo'), 'sk-ant-oat01-VALUE-SKIP')
    const r = await runShimPick(
      ['-w', 'install'],
      { account: 'bravo', kind: 'oauth', banner: 'koloft: → bravo' },
      CRON
    )
    expect(r.realEnv?.CLAUDE_CODE_OAUTH_TOKEN).toBe('sk-ant-oat01-VALUE-SKIP')
    expect(r.reg?.mode).toBe('new')
  }, 30_000)

  it('BB-E19 an explicit --permission-mode still suppresses the injected skip flag', async () => {
    fs.writeFileSync(path.join(fakeKeychainDir, 'bravo'), 'tok-bravo')
    const r = await runShimPick(
      ['--permission-mode', 'acceptEdits', '-w', 'n1'],
      { account: 'bravo', kind: 'oauth', banner: 'koloft: → bravo', skipFlag: true },
      CRON
    )
    expect(r.realEnv?.CLAUDE_CODE_OAUTH_TOKEN).toBe('tok-bravo')
    expect(r.realArgs0).not.toContain('--dangerously-skip-permissions')
    expect(r.realArgs0).toContain('acceptEdits')
  }, 30_000)

  it('BB-E19 `-w update` in the utility terminal is still blocked', () => {
    const r = runShim(['-w', 'update'], { ...CRON, KOLOFT_UTIL: '1' })
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('⛔ Koloft')
    expect(r.realArgs0).toBeNull()
  })
})

describe('claude shim (nested Koloft instances)', () => {
  it("skips another Koloft instance's claude shim on PATH, found by the marker on its line 2, instead of the two shims exec'ing each other forever", () => {
    const peerShimDir = fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-peer-shim-'))
    try {
      fs.copyFileSync(path.join(shimDir, 'claude'), path.join(peerShimDir, 'claude'))
      fs.chmodSync(path.join(peerShimDir, 'claude'), 0o755)
      const r = runShim(['--version'], {
        PATH: `${shimDir}:${peerShimDir}:${realBin}:/usr/bin:/bin`
      })
      expect(r.status).toBe(0)
      expect(r.realArgs).toEqual(['--version'])
    } finally {
      fs.rmSync(peerShimDir, { recursive: true, force: true })
    }
  }, 30_000)
})

describe('claude shim (Koloft browser endpoint)', () => {
  const endpointAt = (port: number): string => `ws://127.0.0.1:${port}/cdp/${'a'.repeat(32)}`

  it('exports the browser endpoint to the launched claude even with the account balancer off, re-reads the per-tab file on every launch so a changed port reaches an already-open tab, and never gives it to a utility shell', () => {
    const cdpDir = fs.mkdtempSync(path.join(base, 'cdp-'))
    const cdpEnv = { KOLOFT_CDP_DIR: cdpDir }

    fs.writeFileSync(path.join(cdpDir, 'tab-shim'), endpointAt(1111))
    const first = runShim([], cdpEnv)
    expect(first.realEnv?.KOLOFT_BROWSER_CDP).toBe(endpointAt(1111))
    expect(first.realEnv?.PLAYWRIGHT_MCP_CDP_ENDPOINT).toBe(endpointAt(1111))

    fs.writeFileSync(path.join(cdpDir, 'tab-shim'), endpointAt(2222))
    const afterPortChange = runShim([], cdpEnv)
    expect(afterPortChange.realEnv?.KOLOFT_BROWSER_CDP).toBe(endpointAt(2222))
    expect(afterPortChange.realEnv?.PLAYWRIGHT_MCP_CDP_ENDPOINT).toBe(endpointAt(2222))

    const utilityShell = runShim(['--version'], { ...cdpEnv, KOLOFT_UTIL: '1' })
    expect(utilityShell.realArgs).toEqual(['--version'])
    expect(utilityShell.realEnv?.KOLOFT_BROWSER_CDP).toBeUndefined()
    expect(utilityShell.realEnv?.PLAYWRIGHT_MCP_CDP_ENDPOINT).toBeUndefined()
  })
})
