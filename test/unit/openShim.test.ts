import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { spawnSync } from 'child_process'

// setupShim() calls app.getPath('userData'); stub Electron so it writes the real shim
// scripts into a throwaway base dir. The factory is async so it can create the dir with
// node builtins (vi.mock is hoisted above normal imports).
vi.mock('electron', async () => {
  const nfs = await import('node:fs')
  const nos = await import('node:os')
  const npath = await import('node:path')
  const base = nfs.mkdtempSync(npath.join(nos.tmpdir(), 'koloft-openshim-'))
  // getName() is read by setupShim() to namespace the claude shim's Keychain lookups;
  // irrelevant to the `open` shim under test here, but it must not throw
  return { app: { getPath: () => base, getName: () => 'koloft-dev', isPackaged: false } }
})

import { setupShim } from '../../src/main/shim'

let shimDir: string
let openDir: string
let base: string
let realBin: string
/** a second copy of the open shim, as a nested Koloft instance would put on PATH */
let peerShimDir: string
/** realpath'd fixture dir holding the previewable / unsupported target files */
let fixtures: string
/** a pid guaranteed dead (a short-lived child that already exited) */
let deadPid: string

beforeAll(() => {
  ;({ shimDir, openDir } = setupShim())
  base = path.dirname(shimDir)
  // a fake "real" open, found on PATH *after* the shim dir. It records the exact argv
  // the shim exec'd it with, so we can assert exact-passthrough (and its absence).
  realBin = fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-realopen-'))
  fs.writeFileSync(
    path.join(realBin, 'open'),
    '#!/usr/bin/env bash\nprintf "%s\\n" "$@" > "$KOLOFT_ARGS_OUT"\nexit 0\n',
    { mode: 0o755 }
  )
  fs.chmodSync(path.join(realBin, 'open'), 0o755)

  // a peer instance's shim: byte-identical script in another dir (nested dev+packaged
  // Kolofts). The passthrough scan must skip it by marker, not exec it (infinite loop).
  peerShimDir = fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-peershim-'))
  fs.copyFileSync(path.join(shimDir, 'open'), path.join(peerShimDir, 'open'))
  fs.chmodSync(path.join(peerShimDir, 'open'), 0o755)

  // realpath'd so the /tmp -> /private/tmp symlink can't skew the abs-path assertions
  fixtures = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-open-fix-')))
  fs.writeFileSync(path.join(fixtures, 'doc.md'), '# doc\n')
  fs.writeFileSync(path.join(fixtures, 'SHOUT.MD'), '# shout\n')
  fs.writeFileSync(path.join(fixtures, 'data.xyz'), 'nope\n')
  fs.writeFileSync(path.join(fixtures, 'sp ace"d.md'), '# spaced\n')
  fs.writeFileSync(path.join(fixtures, 'has space.md'), '# spaced\n')
  fs.writeFileSync(path.join(fixtures, 'bad\nname.md'), '# control char\n')
  fs.writeFileSync(path.join(fixtures, 'page.html'), '<h1>page</h1>\n')

  const child = spawnSync('bash', ['-c', 'echo $$'], { encoding: 'utf8' })
  deadPid = child.stdout.trim()
})

afterAll(() => {
  fs.rmSync(base, { recursive: true, force: true })
  fs.rmSync(realBin, { recursive: true, force: true })
  fs.rmSync(peerShimDir, { recursive: true, force: true })
  fs.rmSync(fixtures, { recursive: true, force: true })
})

beforeEach(() => {
  for (const f of fs.readdirSync(openDir)) fs.rmSync(path.join(openDir, f), { force: true })
})

interface OpenReg {
  tabId: string
  openId: string
  path: string
  url: string
  cwd: string
}

interface OpenRun {
  regs: OpenReg[]
  realArgs: string[] | null
}

/** Run the installed open shim as if a tab process invoked `open <args>`. The 10s
 *  timeout turns a passthrough exec-loop regression into a loud failure, not a hang. */
function runOpenShim(
  args: string[],
  cwd: string,
  envPatch: Record<string, string> = {},
  pathDirs?: string[]
): OpenRun {
  const argsOut = path.join(base, `args-${Math.random().toString(36).slice(2)}`)
  const res = spawnSync(path.join(shimDir, 'open'), args, {
    cwd,
    timeout: 10_000,
    env: {
      ...process.env,
      PATH: (pathDirs ?? [shimDir, realBin, '/usr/bin', '/bin']).join(':'),
      PWD: cwd,
      KOLOFT_TAB_ID: 'tab-open',
      KOLOFT_OPEN_DIR: openDir,
      KOLOFT_PID: String(process.pid), // the "owning Koloft" is this live test process
      KOLOFT_ARGS_OUT: argsOut,
      ...envPatch
    },
    encoding: 'utf8'
  })
  if (res.status !== 0) {
    throw new Error(`open shim exited ${res.status} (signal ${res.signal}): ${res.stderr}`)
  }

  const regs = fs
    .readdirSync(openDir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(fs.readFileSync(path.join(openDir, f), 'utf8')) as OpenReg)
  const realArgs = fs.existsSync(argsOut)
    ? fs.readFileSync(argsOut, 'utf8').split('\n').filter(Boolean)
    : null
  return { regs, realArgs }
}

describe('open shim: interception', () => {
  it('a previewable file registers an open request and never reaches the real open', () => {
    const { regs, realArgs } = runOpenShim([path.join(fixtures, 'doc.md')], os.tmpdir())
    expect(realArgs).toBeNull()
    expect(regs).toHaveLength(1)
    expect(regs[0].tabId).toBe('tab-open')
    expect(regs[0].path).toBe(path.join(fixtures, 'doc.md'))
    expect(regs[0].openId).toBeTruthy()
  })

  it('a relative path resolves against the caller cwd', () => {
    const { regs, realArgs } = runOpenShim(['doc.md'], fixtures)
    expect(realArgs).toBeNull()
    expect(regs[0].path).toBe(path.join(fixtures, 'doc.md'))
    expect(regs[0].cwd).toBe(fixtures)
  })

  it('extension matching is case-insensitive', () => {
    const { regs, realArgs } = runOpenShim(['SHOUT.MD'], fixtures)
    expect(realArgs).toBeNull()
    expect(regs[0].path).toBe(path.join(fixtures, 'SHOUT.MD'))
  })

  it('a file:// URL of a previewable file is intercepted with the plain path', () => {
    const target = path.join(fixtures, 'doc.md')
    const { regs, realArgs } = runOpenShim([`file://${target}`], os.tmpdir())
    expect(realArgs).toBeNull()
    expect(regs[0].path).toBe(target)
  })

  it('a percent-encoded file:// URL (space) is decoded before the existence check', () => {
    const url = `file://${fixtures}/has%20space.md`
    const { regs, realArgs } = runOpenShim([url], os.tmpdir())
    expect(realArgs).toBeNull()
    expect(regs[0].path).toBe(path.join(fixtures, 'has space.md'))
  })

  it('spaces and double-quotes in the path still produce a valid registration', () => {
    const target = path.join(fixtures, 'sp ace"d.md')
    const { regs, realArgs } = runOpenShim([target], os.tmpdir())
    expect(realArgs).toBeNull()
    expect(regs[0].path).toBe(target) // JSON.parse already succeeded in runOpenShim
  })

  // IMPL-3: an `.html` left the Preview extension set with D5 but must stay intercepted
  // — a bare EXT_GLOBS regression here is the silent "open x.html launches Safari" bug.
  it('an .html file is intercepted like any other viewable file', () => {
    const { regs, realArgs } = runOpenShim(['page.html'], fixtures)
    expect(realArgs).toBeNull()
    expect(regs[0].path).toBe(path.join(fixtures, 'page.html'))
  })

  it('an http(s) URL registers as a url request, never as a path', () => {
    for (const target of ['http://localhost:5173/a', 'https://example.com/x?y=1']) {
      for (const f of fs.readdirSync(openDir)) fs.rmSync(path.join(openDir, f), { force: true })
      const { regs, realArgs } = runOpenShim([target], fixtures)
      expect(realArgs, target).toBeNull()
      expect(regs[0].url, target).toBe(target)
      // the cwd-prefix rule is filesystem-only: prefixing a URL would make it a path
      // no router could ever resolve
      expect(regs[0].path, target).toBe('')
      expect(regs[0].cwd, target).toBe(fixtures)
    }
  })
})

describe('open shim: passthrough', () => {
  const cwd = os.tmpdir()

  it('an unsupported extension passes through with the exact argv', () => {
    const { regs, realArgs } = runOpenShim(['data.xyz'], fixtures)
    expect(regs).toEqual([])
    expect(realArgs).toEqual(['data.xyz'])
  })

  it('any flag (a <app>) passes the whole call through, even with a previewable file', () => {
    const target = path.join(fixtures, 'doc.md')
    const { regs, realArgs } = runOpenShim(['-a', 'Safari', target], cwd)
    expect(regs).toEqual([])
    expect(realArgs).toEqual(['-a', 'Safari', target])
  })

  // session-browser IMPL-3 overturns the old "URLs pass through" rule: http(s) is now
  // Koloft's own surface, and passing it through is the G0 breach (Safari opens instead).
  // Every OTHER scheme still belongs to the OS.
  it('a non-http scheme passes through with the exact argv', () => {
    const { regs, realArgs } = runOpenShim(['zoommtg://example'], cwd)
    expect(regs).toEqual([])
    expect(realArgs).toEqual(['zoommtg://example'])
  })

  it('no arguments passes through', () => {
    const { regs, realArgs } = runOpenShim([], cwd)
    expect(regs).toEqual([])
    expect(realArgs).not.toBeNull() // recorder ran (with an empty argv)
  })

  it('a missing file passes through (the real open reports the error)', () => {
    const { regs, realArgs } = runOpenShim(['nope.md'], fixtures)
    expect(regs).toEqual([])
    expect(realArgs).toEqual(['nope.md'])
  })

  it('multiple files pass the whole call through — the viewer shows one file, so intercepting any subset would drop the rest', () => {
    const { regs, realArgs } = runOpenShim(['doc.md', 'SHOUT.MD'], fixtures)
    expect(regs).toEqual([])
    expect(realArgs).toEqual(['doc.md', 'SHOUT.MD'])
  })

  it('a control character in the path passes through instead of corrupting the JSON handoff', () => {
    const { regs, realArgs } = runOpenShim(['bad\nname.md'], fixtures)
    expect(regs).toEqual([])
    // the recorder writes argv newline-separated, so the embedded \n splits it —
    // joining reconstructs the single original argument
    expect(realArgs?.join('\n')).toBe('bad\nname.md')
  })

  it('outside a Koloft tab (no KOLOFT_TAB_ID) everything passes through', () => {
    const { regs, realArgs } = runOpenShim(['doc.md'], fixtures, { KOLOFT_TAB_ID: '' })
    expect(regs).toEqual([])
    expect(realArgs).toEqual(['doc.md'])
  })

  it('without a request dir (no KOLOFT_OPEN_DIR) everything passes through', () => {
    const { regs, realArgs } = runOpenShim(['doc.md'], fixtures, { KOLOFT_OPEN_DIR: '' })
    expect(regs).toEqual([])
    expect(realArgs).toEqual(['doc.md'])
  })

  it('with the owning Koloft process dead (stale env in a tmux/nohup survivor) everything passes through', () => {
    const { regs, realArgs } = runOpenShim(['doc.md'], fixtures, { KOLOFT_PID: deadPid })
    expect(regs).toEqual([])
    expect(realArgs).toEqual(['doc.md'])
  })

  it('without KOLOFT_PID everything passes through', () => {
    const { regs, realArgs } = runOpenShim(['doc.md'], fixtures, { KOLOFT_PID: '' })
    expect(regs).toEqual([])
    expect(realArgs).toEqual(['doc.md'])
  })

  it("skips a peer Koloft instance's open shim on PATH instead of exec-looping through it", () => {
    // nested instances: self shim first, the PEER's shim next, the real open last.
    // Without the marker skip the two shims exec each other forever (timeout kills).
    const { regs, realArgs } = runOpenShim(['data.xyz'], fixtures, {}, [
      shimDir,
      peerShimDir,
      realBin,
      '/usr/bin',
      '/bin'
    ])
    expect(regs).toEqual([])
    expect(realArgs).toEqual(['data.xyz'])
  })

  it('an unwritable request dir falls back to the real open instead of exiting 0 with the open lost', () => {
    const lockedDir = path.join(base, 'locked-opens')
    fs.mkdirSync(lockedDir, { recursive: true })
    fs.chmodSync(lockedDir, 0o555)
    try {
      const { realArgs } = runOpenShim(['doc.md'], fixtures, { KOLOFT_OPEN_DIR: lockedDir })
      expect(realArgs).toEqual(['doc.md'])
      expect(fs.readdirSync(lockedDir)).toEqual([])
    } finally {
      fs.chmodSync(lockedDir, 0o755)
    }
  })
})
