import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import http from 'http'
import type { AddressInfo } from 'net'
import { execFileSync } from 'child_process'
import { GitFreshnessEngine } from '../../src/main/gitFreshness'
import type { WorkspaceFreshness } from '@shared/types'

// The engine measures a REAL checkout against a REAL remote — the only way to pin
// git's own contracts (rev-list column order, that a fetch moves the tracking ref,
// that --ff-only refuses a diverged branch with its exact wording). Everything is
// local: the origin is a bare repo reached over a plain path, no network.

let tmp: string
/** the bare repo standing in for origin */
let origin: string
/** the workspace under test (a clone of origin) */
let work: string
/** a second clone used to publish upstream commits */
let other: string
/** the real PATH, restored after a test that shims `git` into it */
let realPath: string

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' })
}

function commit(repo: string, name: string): void {
  fs.writeFileSync(path.join(repo, name), name + '\n')
  git(repo, 'add', name)
  git(repo, 'commit', '-q', '-m', name)
}

beforeEach(() => {
  realPath = process.env.PATH ?? ''
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-fresh-')))
  const seed = path.join(tmp, 'seed')
  execFileSync('git', ['init', '-q', '-b', 'main', seed])
  git(seed, 'config', 'user.email', 't@t.com')
  git(seed, 'config', 'user.name', 't')
  commit(seed, 'a.txt')
  origin = path.join(tmp, 'origin.git')
  execFileSync('git', ['clone', '-q', '--bare', seed, origin])
  work = path.join(tmp, 'work')
  execFileSync('git', ['clone', '-q', origin, work])
  git(work, 'config', 'user.email', 't@t.com')
  git(work, 'config', 'user.name', 't')
  other = path.join(tmp, 'other')
  execFileSync('git', ['clone', '-q', origin, other])
  git(other, 'config', 'user.email', 't@t.com')
  git(other, 'config', 'user.name', 't')
})

afterEach(() => {
  process.env.PATH = realPath
  fs.rmSync(tmp, { recursive: true, force: true })
})

/** publish `n` commits to origin's main from the sibling clone */
function publish(n: number): void {
  for (let i = 0; i < n; i++) commit(other, `up${i}.txt`)
  git(other, 'push', '-q', 'origin', 'main')
}

interface Harness {
  engine: GitFreshnessEngine
  changed: string[]
  setNow(ms: number): void
}

function harness(
  opts: {
    autoFetch?: () => boolean
    paths?: string[]
    missing?: string[]
    gitBin?: string
    fetchTimeoutMs?: number
  } = {}
): Harness {
  const changed: string[] = []
  let now = 1_700_000_000_000
  const engine = new GitFreshnessEngine(
    {
      workspaces: () =>
        (opts.paths ?? [work]).map((p) => ({
          path: p,
          missing: opts.missing ? opts.missing.includes(p) : !fs.existsSync(p)
        })),
      autoFetch: opts.autoFetch ?? ((): boolean => true),
      onChange: (p) => changed.push(p),
      now: () => now
    },
    { gitBin: opts.gitBin, fetchTimeoutMs: opts.fetchTimeoutMs }
  )
  return { engine, changed, setNow: (ms) => (now = ms) }
}

/** A `git` stand-in on disk: logs every invocation (spawn counting) and, once, sleeps
 *  through a `rev-list` when the flag file exists — the only way to hold a LOCAL
 *  measurement open while a fetch overtakes it. */
function gitWrapper(name: string, opts: { slowFlag?: string } = {}): { bin: string; log: string } {
  const bin = path.join(tmp, name)
  const log = path.join(tmp, name + '.log')
  const slow = opts.slowFlag
    ? `case " $* " in *" rev-list "*) if [ -f '${opts.slowFlag}' ]; then rm -f '${opts.slowFlag}'; sleep 1; fi;; esac\n`
    : ''
  fs.writeFileSync(bin, `#!/bin/sh\necho "$*" >> '${log}'\n${slow}exec git "$@"\n`, { mode: 0o755 })
  return { bin, log }
}

/** Like `gitWrapper`, but installed FIRST ON PATH, so it also catches the calls that go
 *  through `defaultBranch` — that one spawns a literal `git`, not the engine's gitBin. */
function loggingGitOnPath(name: string): string {
  const dir = path.join(tmp, name + '-bin')
  fs.mkdirSync(dir, { recursive: true })
  const log = path.join(tmp, name + '.log')
  const real = execFileSync('which', ['git'], { encoding: 'utf8' }).trim()
  fs.writeFileSync(
    path.join(dir, 'git'),
    `#!/bin/sh\necho "$*" >> '${log}'\nexec '${real}' "$@"\n`,
    {
      mode: 0o755
    }
  )
  process.env.PATH = `${dir}:${realPath}`
  return log
}

function logLines(log: string): string[] {
  if (!fs.existsSync(log)) return []
  return fs
    .readFileSync(log, 'utf8')
    .split('\n')
    .filter((l) => l !== '')
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** A remote that never answers: git runs the `ext::` helper and waits forever. The
 *  helper records its own pid and that of a grandchild, so a test can prove the whole
 *  process GROUP died — killing the direct child alone would leave both behind. */
function extRemote(name: string, repo: string = work): { pidFile: string; childFile: string } {
  const pidFile = path.join(tmp, name + '.pid')
  const childFile = path.join(tmp, name + '.child')
  const script = path.join(tmp, name + '.sh')
  fs.writeFileSync(
    script,
    `#!/bin/sh\necho $$ > '${pidFile}'\nsleep 30 &\necho $! > '${childFile}'\nwait\n`,
    { mode: 0o755 }
  )
  git(repo, 'config', 'protocol.ext.allow', 'always') // off by default; scoped to this repo
  git(repo, 'remote', 'set-url', 'origin', `ext::${script}`)
  return { pidFile, childFile }
}

/** `n` fresh clones of origin, each pointed at a remote that never answers */
function hangingClones(n: number): string[] {
  const paths: string[] = []
  for (let i = 0; i < n; i++) {
    const p = path.join(tmp, `slow${i}`)
    execFileSync('git', ['clone', '-q', origin, p])
    extRemote(`slow${i}`, p)
    paths.push(p)
  }
  return paths
}

function fetchLines(log: string): string[] {
  return logLines(log).filter((l) => l.includes(' fetch '))
}

async function waitFor(cond: () => boolean, ms = 3_000): Promise<boolean> {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (cond()) return true
    await new Promise((r) => setTimeout(r, 50))
  }
  return cond()
}

function f(v: WorkspaceFreshness | null | undefined): WorkspaceFreshness {
  if (!v) throw new Error('expected a freshness measurement')
  return v
}

describe('Tier-1 + Tier-2 measurement', () => {
  it('counts behind only after a fetch moves the tracking ref', async () => {
    const h = harness()
    publish(2)
    // Tier-1 alone still compares against the pre-push tracking ref
    await h.engine.refreshLocal([work])
    expect(f(h.engine.get(work)).behind).toBe(0)

    const after = f(await h.engine.fetchNow(work))
    expect(after.state).toBe('ok')
    expect(after.behind).toBe(2)
    expect(after.ahead).toBe(0)
    expect(after.branch).toBe('main')
    expect(after.defRef).toBe('origin/main')
    expect(after.onDefault).toBe(true)
    expect(after.dirty).toBe(false)
    expect(after.head).toBe(git(work, 'rev-parse', 'HEAD').trim())
    expect(after.fetchedAt).not.toBeNull()
    expect(h.changed).toContain(work)
  })

  it('reports local commits as ahead, and a modified tracked file as dirty', async () => {
    const h = harness()
    publish(1)
    commit(work, 'mine.txt')
    fs.writeFileSync(path.join(work, 'a.txt'), 'edited\n')
    const v = f(await h.engine.fetchNow(work))
    expect(v.ahead).toBe(1)
    expect(v.behind).toBe(1)
    expect(v.dirty).toBe(true)
  })

  it('ignores untracked files when judging dirty', async () => {
    const h = harness()
    fs.writeFileSync(path.join(work, 'scratch.txt'), 'x\n')
    expect(f(await h.engine.fetchNow(work)).dirty).toBe(false)
  })

  it('falls through a dangling origin/HEAD to the verified chain', async () => {
    const h = harness()
    // the server renamed master → main: origin/HEAD still points at a ref that is gone
    git(work, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/master')
    const v = f(await h.engine.fetchNow(work))
    expect(v.state).toBe('ok')
    expect(v.defRef).toBe('origin/main')
  })

  it('is state none when only a bare local default resolves (no remote)', async () => {
    const solo = path.join(tmp, 'solo')
    execFileSync('git', ['init', '-q', '-b', 'main', solo])
    git(solo, 'config', 'user.email', 't@t.com')
    git(solo, 'config', 'user.name', 't')
    commit(solo, 'a.txt')
    const h = harness({ paths: [solo] })
    const v = f(await h.engine.fetchNow(solo))
    expect(v.state).toBe('none')
    expect(v.behind).toBe(0)
  })

  it('is state none on a detached HEAD', async () => {
    const h = harness()
    git(work, 'checkout', '-q', '--detach', 'HEAD')
    expect(f(await h.engine.fetchNow(work)).state).toBe('none')
  })

  it('flags a non-default branch as not onDefault but still measures it', async () => {
    const h = harness()
    publish(2)
    git(work, 'checkout', '-q', '-b', 'fix-auth')
    const v = f(await h.engine.fetchNow(work))
    expect(v.branch).toBe('fix-auth')
    expect(v.onDefault).toBe(false)
    expect(v.behind).toBe(2)
  })

  it('keeps the previous counts and turns error when the remote is unreachable', async () => {
    const h = harness()
    publish(2)
    await h.engine.fetchNow(work)
    git(work, 'remote', 'set-url', 'origin', path.join(tmp, 'does-not-exist.git'))
    const v = f(await h.engine.fetchNow(work))
    expect(v.state).toBe('error')
    expect(v.behind).toBe(2) // stale but honest — never silently "up to date"
    expect(v.lastAttemptAt).not.toBeNull()
  })

  it('reports nothing at all for a directory that is not a repo', async () => {
    const plain = path.join(tmp, 'plain')
    fs.mkdirSync(plain)
    const h = harness({ paths: [plain] })
    expect(await h.engine.fetchNow(plain)).toBeNull()
    expect(h.engine.get(plain)).toBeUndefined()
  })
})

describe('pull', () => {
  it('fast-forwards and reports the commit count with short shas', async () => {
    const h = harness()
    publish(2)
    const before = f(await h.engine.fetchNow(work))
    const from = before.head
    const res = await h.engine.pull(work, { branch: before.branch, head: before.head })
    expect(res).toEqual({
      ok: true,
      summary: {
        count: 2,
        from: from.slice(0, 7),
        to: git(work, 'rev-parse', 'HEAD').trim().slice(0, 7)
      }
    })
    const after = f(h.engine.get(work))
    expect(after.behind).toBe(0)
    expect(after.state).toBe('ok')
  })

  it('refuses when HEAD moved under the renderer judgement (TOCTOU)', async () => {
    const h = harness()
    publish(1)
    const before = f(await h.engine.fetchNow(work))
    const res = await h.engine.pull(work, { branch: before.branch, head: 'f'.repeat(40) })
    expect(res).toEqual({ ok: false, reason: 'state changed' })
    expect(git(work, 'rev-parse', 'HEAD').trim()).toBe(before.head) // nothing moved
  })

  it('refuses a diverged branch before it ever execs a pull', async () => {
    const h = harness()
    publish(1)
    commit(work, 'mine.txt')
    const before = f(await h.engine.fetchNow(work))
    expect(before.ahead).toBe(1)
    const res = await h.engine.pull(work, { branch: before.branch, head: before.head })
    expect(res).toEqual({ ok: false, reason: 'state changed' })
  })

  it('refuses a dirty tree', async () => {
    const h = harness()
    publish(1)
    const before = f(await h.engine.fetchNow(work))
    fs.writeFileSync(path.join(work, 'a.txt'), 'edited\n')
    const res = await h.engine.pull(work, { branch: before.branch, head: before.head })
    expect(res).toEqual({ ok: false, reason: 'state changed' })
  })

  it('refuses off the default branch', async () => {
    const h = harness()
    publish(1)
    git(work, 'checkout', '-q', '-b', 'fix-auth')
    const before = f(await h.engine.fetchNow(work))
    const res = await h.engine.pull(work, { branch: before.branch, head: before.head })
    expect(res).toEqual({ ok: false, reason: 'state changed' })
  })

  it("surfaces git's own last error line when the pull itself fails", async () => {
    const h = harness()
    // an untracked file colliding with an incoming one: clean by our dirty rule
    // (-uno), so the pre-check passes and git is the one that refuses
    commit(other, 'clash.txt')
    git(other, 'push', '-q', 'origin', 'main')
    fs.writeFileSync(path.join(work, 'clash.txt'), 'local\n')
    const before = f(await h.engine.fetchNow(work))
    expect(before.dirty).toBe(false)
    const res = await h.engine.pull(work, { branch: before.branch, head: before.head })
    expect(res.ok).toBe(false)
    if (res.ok) throw new Error('unreachable')
    expect(res.reason).toMatch(/^(fatal|error):/)
    expect(res.reason).toMatch(/clash\.txt|untracked|overwritten/i)
  })
})

describe('sweep throttle, backoff and the D8 switch', () => {
  const T0 = 1_700_000_000_000

  it('fetches at most once per 60s per workspace', async () => {
    const h = harness()
    h.setNow(T0)
    await h.engine.sweep()
    expect(f(h.engine.get(work)).lastAttemptAt).toBe(T0)

    h.setNow(T0 + 30_000)
    await h.engine.sweep()
    expect(f(h.engine.get(work)).lastAttemptAt).toBe(T0) // throttled

    h.setNow(T0 + 61_000)
    await h.engine.sweep()
    expect(f(h.engine.get(work)).lastAttemptAt).toBe(T0 + 61_000)
  })

  it('a manual fetch ignores the throttle', async () => {
    const h = harness()
    h.setNow(T0)
    await h.engine.sweep()
    h.setNow(T0 + 1_000)
    await h.engine.fetchNow(work)
    expect(f(h.engine.get(work)).lastAttemptAt).toBe(T0 + 1_000)
  })

  it('backs off automatic fetches after three consecutive failures', async () => {
    const h = harness()
    git(work, 'remote', 'set-url', 'origin', path.join(tmp, 'does-not-exist.git'))
    let t = T0
    for (let i = 0; i < 3; i++) {
      h.setNow(t)
      await h.engine.sweep()
      t += 61_000
    }
    const lastTry = f(h.engine.get(work)).lastAttemptAt
    h.setNow(t)
    await h.engine.sweep()
    expect(f(h.engine.get(work)).lastAttemptAt).toBe(lastTry) // skipped by the backoff

    // a manual fetch always gets through, and clears the backoff
    h.setNow(t + 1_000)
    await h.engine.fetchNow(work)
    expect(f(h.engine.get(work)).lastAttemptAt).toBe(t + 1_000)
  })

  it('gitAutoFetch=false stops sweeps but never the manual entry', async () => {
    const h = harness({ autoFetch: () => false })
    h.setNow(T0)
    await h.engine.sweep()
    expect(h.engine.get(work)).toBeUndefined()
    await h.engine.fetchNow(work)
    expect(f(h.engine.get(work)).lastAttemptAt).toBe(T0)
  })

  it('skips a workspace whose directory is gone', async () => {
    const gone = path.join(tmp, 'gone')
    const h = harness({ paths: [gone] })
    await h.engine.sweep()
    expect(h.engine.get(gone)).toBeUndefined()
  })

  it('rate-limits the Tier-1 piggyback (a rescan fires every 250ms while an agent writes)', async () => {
    const h = harness()
    publish(2)
    h.setNow(T0)
    await h.engine.fetchNow(work)
    expect(f(h.engine.get(work)).behind).toBe(2)

    git(work, 'merge', '-q', '--ff-only', 'origin/main') // the user pulled elsewhere
    h.setNow(T0 + 5_000)
    await h.engine.refreshLocal([work])
    expect(f(h.engine.get(work)).behind).toBe(2) // skipped: measured moments ago

    h.setNow(T0 + 11_000)
    await h.engine.refreshLocal([work])
    expect(f(h.engine.get(work)).behind).toBe(0)
  })

  it('joins an in-flight fetch instead of spawning a second git', async () => {
    const h = harness()
    publish(1)
    const [a, b] = await Promise.all([h.engine.fetchNow(work), h.engine.fetchNow(work)])
    expect(a).toBe(b) // the very same object: one measurement, one process
  })
})

describe('linked worktrees and submodules', () => {
  it('flags a linked worktree on the default branch, and refuses to pull it', async () => {
    git(work, 'checkout', '-q', '-b', 'side')
    const wt = path.join(tmp, 'wt')
    git(work, 'worktree', 'add', '-q', wt, 'main')
    publish(2)
    const h = harness({ paths: [wt] })
    const v = f(await h.engine.fetchNow(wt))
    expect(v.linked).toBe(true)
    expect(v.onDefault).toBe(true)
    expect(v.behind).toBe(2)
    // D5: Koloft only ever fast-forwards a MAIN checkout
    const res = await h.engine.pull(wt, { branch: v.branch, head: v.head })
    expect(res).toEqual({ ok: false, reason: 'state changed' })
  })

  it('a main checkout is not linked', async () => {
    const h = harness()
    expect(f(await h.engine.fetchNow(work)).linked).toBe(false)
  })

  it('reports a .gitmodules at the root', async () => {
    const h = harness()
    expect(f(await h.engine.fetchNow(work)).hasSubmodules).toBe(false)
    fs.writeFileSync(path.join(work, '.gitmodules'), '[submodule "x"]\n')
    h.setNow(1_700_000_100_000)
    expect(f(await h.engine.fetchNow(work)).hasSubmodules).toBe(true)
  })
})

describe('fetch health', () => {
  const T0 = 1_700_000_000_000

  it('survives a local re-measure and clears only on a successful fetch', async () => {
    const h = harness()
    publish(2)
    h.setNow(T0)
    await h.engine.fetchNow(work)
    const good = git(work, 'remote', 'get-url', 'origin').trim()
    git(work, 'remote', 'set-url', 'origin', path.join(tmp, 'does-not-exist.git'))
    h.setNow(T0 + 61_000)
    expect(f(await h.engine.fetchNow(work)).state).toBe('error')

    // the Tier-1 piggyback must not stamp 'ok' over a live fetch failure — the backoff
    // is suppressing re-fetches, so the offline UI would become unreachable
    h.setNow(T0 + 120_000)
    await h.engine.refreshLocal([work])
    expect(f(h.engine.get(work)).state).toBe('error')

    git(work, 'remote', 'set-url', 'origin', good)
    h.setNow(T0 + 180_000)
    expect(f(await h.engine.fetchNow(work)).state).toBe('ok')
  })

  it('a fetch landing during a local measure is not overwritten by it', async () => {
    const flag = path.join(tmp, 'slow-rev-list')
    fs.writeFileSync(flag, '')
    const w = gitWrapper('git-slow', { slowFlag: flag })
    const h = harness({ gitBin: w.bin })
    publish(2)
    const local = h.engine.refreshLocal([work]) // its rev-list sleeps for a second
    await new Promise((r) => setTimeout(r, 300))
    const fetched = f(await h.engine.fetchNow(work))
    expect(fetched.behind).toBe(2)
    await local
    const after = f(h.engine.get(work))
    expect(after.behind).toBe(2) // the pre-fetch local numbers did not land on top
    expect(after.fetchedAt).toBe(fetched.fetchedAt)
  })
})

describe('the local floor and the missing filter', () => {
  const T0 = 1_700_000_000_000

  it('honors the floor for a path that measures nothing at all', async () => {
    const plain = path.join(tmp, 'plain')
    fs.mkdirSync(plain)
    const w = gitWrapper('git-count')
    const h = harness({ paths: [plain], gitBin: w.bin })
    h.setNow(T0)
    await h.engine.refreshLocal([plain])
    h.setNow(T0 + 5_000)
    await h.engine.refreshLocal([plain])
    expect(logLines(w.log).length).toBe(1)
  })

  it('never measures a workspace whose directory is gone', async () => {
    const gone = path.join(tmp, 'gone')
    const w = gitWrapper('git-gone')
    const h = harness({ paths: [gone], missing: [gone], gitBin: w.bin })
    await h.engine.refreshLocal([gone])
    expect(logLines(w.log)).toEqual([])
  })
})

describe('git missing from PATH', () => {
  it('latches on the first ENOENT and never spawns again', async () => {
    const bin = path.join(tmp, 'no-such-git')
    const log = bin + '.log'
    const h = harness({ gitBin: bin })
    expect(await h.engine.fetchNow(work)).toBeNull()
    expect(h.engine.get(work)).toBeUndefined()

    // the same path now exists as a logging wrapper: anything that still spawns
    // leaves a line behind
    fs.writeFileSync(bin, `#!/bin/sh\necho "$*" >> '${log}'\nexec git "$@"\n`, { mode: 0o755 })
    expect(await h.engine.fetchNow(work)).toBeNull()
    await h.engine.refreshLocal([work])
    await h.engine.sweep()
    expect((await h.engine.pull(work, { branch: 'main', head: 'a'.repeat(40) })).ok).toBe(false)
    expect(logLines(log)).toEqual([])
    expect(h.engine.get(work)).toBeUndefined()
  })
})

describe('network safety', () => {
  it('never lets git ask for credentials, however the repo is configured', async () => {
    const marker = path.join(tmp, 'askpass-called')
    const askpass = path.join(tmp, 'askpass.sh')
    fs.writeFileSync(askpass, `#!/bin/sh\necho called > '${marker}'\necho hunter2\n`, {
      mode: 0o755
    })
    const server = http.createServer((_req, res) => {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="koloft"' })
      res.end('nope')
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    const port = (server.address() as AddressInfo).port
    try {
      git(work, 'config', 'credential.helper', '') // never touch the real keychain
      git(work, 'config', 'core.askpass', askpass)
      git(work, 'remote', 'set-url', 'origin', `http://127.0.0.1:${port}/x.git`)
      const h = harness({ fetchTimeoutMs: 8_000 })
      const t = Date.now()
      expect(f(await h.engine.fetchNow(work)).state).toBe('error')
      // it FAILED rather than hanging until the timeout: GIT_TERMINAL_PROMPT=0 in force
      expect(Date.now() - t).toBeLessThan(6_000)
      // GIT_ASKPASS beats the repo's own core.askpass — the helper never ran
      expect(fs.existsSync(marker)).toBe(false)
    } finally {
      server.close()
    }
  })

  it('times out a hung fetch and takes its whole process group with it', async () => {
    const r = extRemote('hang')
    const h = harness({ fetchTimeoutMs: 1_500 })
    const t = Date.now()
    expect(f(await h.engine.fetchNow(work)).state).toBe('error')
    expect(Date.now() - t).toBeLessThan(8_000)
    expect(await waitFor(() => fs.existsSync(r.childFile))).toBe(true)
    const helper = Number(fs.readFileSync(r.pidFile, 'utf8').trim())
    const child = Number(fs.readFileSync(r.childFile, 'utf8').trim())
    expect(await waitFor(() => !alive(helper) && !alive(child))).toBe(true)
  })

  it('stop() kills a fetch still in flight (before-quit)', async () => {
    const r = extRemote('quit')
    const h = harness({ fetchTimeoutMs: 30_000 })
    const p = h.engine.fetchNow(work)
    expect(await waitFor(() => fs.existsSync(r.childFile))).toBe(true)
    const helper = Number(fs.readFileSync(r.pidFile, 'utf8').trim())
    const child = Number(fs.readFileSync(r.childFile, 'utf8').trim())
    h.engine.stop()
    expect(await waitFor(() => !alive(helper) && !alive(child))).toBe(true)
    await p
  })
})

describe('stop() closes the door on new work (before-quit)', () => {
  it('a sweep already running spawns nothing more once stopped', async () => {
    const third = path.join(tmp, 'third')
    execFileSync('git', ['clone', '-q', origin, third])
    const w = gitWrapper('git-stop')
    const h = harness({ paths: [work, other, third], gitBin: w.bin })

    const p = h.engine.sweep({ stagger: true })
    expect(await waitFor(() => fetchLines(w.log).length >= 1)).toBe(true)
    h.engine.stop()
    const atStop = fetchLines(w.log).length
    await p
    // past every stagger slot the sweep still had left
    await new Promise((r) => setTimeout(r, 2 * 750 + 400))
    expect(fetchLines(w.log).length).toBe(atStop)
    expect(atStop).toBeLessThan(3) // it really did abandon the rest of the round
  })

  it('refuses the manual entries after stop()', async () => {
    const w = gitWrapper('git-after-stop')
    const h = harness({ gitBin: w.bin })
    h.engine.stop()
    expect(await h.engine.fetchNow(work)).toBeNull()
    expect((await h.engine.pull(work, { branch: 'main', head: 'a'.repeat(40) })).ok).toBe(false)
    await h.engine.sweep()
    expect(fetchLines(w.log)).toEqual([])
  })
})

describe('unmeasurable pins are throttled like every other path', () => {
  const T0 = 1_700_000_000_000

  it('does not re-probe a non-repo pin on every sweep', async () => {
    const plain = path.join(tmp, 'plain')
    fs.mkdirSync(plain)
    const w = gitWrapper('git-null-sweep')
    const h = harness({ paths: [plain], gitBin: w.bin })
    h.setNow(T0)
    await h.engine.sweep()
    const first = logLines(w.log).length
    expect(first).toBeGreaterThan(0)

    h.setNow(T0 + 5_000)
    await h.engine.sweep()
    expect(logLines(w.log).length).toBe(first) // throttled: nothing cached, still bookkept

    h.setNow(T0 + 61_000)
    await h.engine.sweep()
    expect(logLines(w.log).length).toBeGreaterThan(first) // the 60s window reopens
  })

  it('backs a permanently unmeasurable pin off after the same three strikes', async () => {
    const plain = path.join(tmp, 'plain')
    fs.mkdirSync(plain)
    const w = gitWrapper('git-null-backoff')
    const h = harness({ paths: [plain], gitBin: w.bin })
    let t = T0
    for (let i = 0; i < 3; i++) {
      h.setNow(t)
      await h.engine.sweep()
      t += 61_000
    }
    const struck = logLines(w.log).length
    h.setNow(t)
    await h.engine.sweep()
    expect(logLines(w.log).length).toBe(struck) // in backoff, not re-probed
  })
})

describe('sweep concurrency', () => {
  it('runs a slow round with bounded concurrency, not strictly serially', async () => {
    const paths = hangingClones(4)
    const h = harness({ paths, fetchTimeoutMs: 1_500 })
    const t = Date.now()
    await h.engine.sweep()
    const ms = Date.now() - t
    // serial would be 4 × 1.5s ≈ 6s; a cap of 3 means two waves ≈ 3s
    expect(ms).toBeGreaterThan(1_400) // the timeout really is what bounds each fetch
    expect(ms).toBeLessThan(5_000)
  }, 30_000)
})

describe('default-ref memo', () => {
  const T0 = 1_700_000_000_000

  it('verifies the remembered ref instead of re-deriving it every measure', async () => {
    const log = loggingGitOnPath('defref') // catches defaultBranch's literal `git` too
    const h = harness()
    h.setNow(T0)
    await h.engine.fetchNow(work)
    const cold = logLines(log).length
    expect(logLines(log).filter((l) => l.includes('symbolic-ref')).length).toBe(1)

    h.setNow(T0 + 61_000)
    await h.engine.fetchNow(work)
    const warm = logLines(log).length - cold
    // the probe chain ran once, for the first measurement only
    expect(logLines(log).filter((l) => l.includes('symbolic-ref')).length).toBe(1)
    expect(warm).toBeLessThan(cold)
  })

  it('re-derives once the remembered ref stops resolving', async () => {
    const h = harness()
    expect(f(await h.engine.fetchNow(work)).defRef).toBe('origin/main')
    // the server renamed main → master: the memoized origin/main is gone
    git(work, 'branch', '-m', '-q', 'main', 'master')
    git(work, 'update-ref', 'refs/remotes/origin/master', 'refs/remotes/origin/main')
    git(work, 'update-ref', '-d', 'refs/remotes/origin/main')
    h.setNow(1_700_000_100_000)
    expect(f(await h.engine.fetchNow(work)).defRef).toBe('origin/master')
  })
})

describe('remote workspaces', () => {
  // U-FRESH-1: a remote key names no repo on this Mac. Left in, every sweep would run
  // git against a path that cannot exist and fill the log with errors.
  it('never measures a remote key, and still measures the local pins beside it', async () => {
    const w = gitWrapper('git-remote-filter')
    const h = harness({ paths: [work, 'ssh://devbox/x'], gitBin: w.bin })
    await h.engine.sweep()
    await h.engine.refreshLocal([work, 'ssh://devbox/x'])
    const lines = logLines(w.log).join('\n')
    expect(lines).not.toContain('ssh://')
    expect(lines).toContain(work)
  })
})
