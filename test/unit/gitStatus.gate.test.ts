import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { execFileSync } from 'child_process'
import { gitStatus } from '../../src/main/gitStatus'
import { filterGitSpawns, parseGitSpawns, type GitSpawn } from '../e2e/helpers/gitSpawnLog'
import { gitOnPath, realGit, recordArgv, restorePath, seedRepo } from './helpers/gitShim'

/**
 * The in-flight gate: while one query is running, every caller that arrives for the SAME
 * query shares ONE re-run behind it instead of spawning its own round. Measured through a
 * `git` on PATH that runs the real one and then lingers, so a whole round overlaps the
 * callers that arrive during it — which is exactly what the Changes panel does when the
 * watcher ticks faster than git answers.
 *
 * A late caller gets the TRAILING run's answer, never the in-flight one's: it was woken by
 * a change the running git may already have missed.
 */

let tmp: string
let repo: string
let log: string
let scanned: string

/** a `git` that records its argv, runs the real git IMMEDIATELY (so what git saw is fixed
 *  at spawn time), then lingers before handing the output back. It logs a second time once
 *  the real git has ANSWERED — a case that changes the tree mid-run needs to know the scan
 *  is behind it, and the spawn line alone does not say that. */
function laggingGitOnPath(sleepSecs: number): void {
  gitOnPath(
    tmp,
    `#!/usr/bin/env bash\n` +
      recordArgv(log) +
      `__out=$(mktemp); "${realGit()}" "$@" > "$__out"; __rc=$?\n` +
      `printf '%s\\n' "$__line" >> "${scanned}"\n` +
      `sleep ${sleepSecs}; cat "$__out"; rm -f "$__out"; exit $__rc\n`
  )
}

const readLog = (file: string): GitSpawn[] =>
  fs.existsSync(file) ? parseGitSpawns(fs.readFileSync(file, 'utf8')) : []

function resetLog(): void {
  fs.rmSync(log, { force: true })
  fs.rmSync(scanned, { force: true })
}

const untrackedListings = (): GitSpawn[] =>
  filterGitSpawns(readLog(log), { argv: (a) => a.includes('--others') })

const nameStatusDiffs = (): GitSpawn[] =>
  filterGitSpawns(readLog(log), { argv: (a) => a.includes('--name-status') })

const git = (...args: string[]): string =>
  execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim()

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-gitgate-')))
  log = path.join(tmp, 'git-calls.log')
  scanned = path.join(tmp, 'git-scanned.log')
  repo = path.join(tmp, 'work')
  seedRepo(repo)
})

afterEach(() => {
  restorePath()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('the in-flight gate', () => {
  it('five gitStatus calls that overlap one slow run spawn exactly two rounds: the run in flight and one trailing', async () => {
    const base = git('rev-parse', 'HEAD')
    await gitStatus(repo, base) // warm the toplevel cache with a fast git
    laggingGitOnPath(0.2)
    resetLog()

    const results = await Promise.all(Array.from({ length: 5 }, () => gitStatus(repo, base)))
    expect(untrackedListings()).toHaveLength(2)
    for (const r of results) expect(r).toEqual(results[0])

    // both rounds are over, so the slot was released: a later call runs on its own
    resetLog()
    await gitStatus(repo, base)
    expect(untrackedListings()).toHaveLength(1)
  }, 15_000)

  it("a caller who arrives mid-run gets the trailing run's answer, which sees the change that woke it", async () => {
    const base = git('rev-parse', 'HEAD')
    await gitStatus(repo, base) // warm the toplevel cache
    laggingGitOnPath(0.3)
    resetLog()

    const fresh = path.join(repo, 'fresh.txt')
    const a = gitStatus(repo, base)
    // the running round has already listed the untracked files, so it cannot see this one
    await vi.waitFor(() =>
      expect(readLog(scanned).some((s) => s.argv.includes('--others'))).toBe(true)
    )
    fs.writeFileSync(fresh, 'new\n')
    const b = gitStatus(repo, base)
    const c = gitStatus(repo, base)

    expect((await a)[fresh]).toBeUndefined()
    expect((await b)[fresh]).toBe('untracked')
    expect((await c)[fresh]).toBe('untracked')
    expect(untrackedListings()).toHaveLength(2)
  }, 15_000)

  it('queries that differ in base are different keys: each caller is answered against its own base', async () => {
    const first = git('rev-parse', 'HEAD')
    fs.writeFileSync(path.join(repo, 'second.txt'), 'second\n')
    git('add', '-A')
    git('commit', '-q', '-m', 'second')
    const second = path.join(repo, 'second.txt')
    await gitStatus(repo, first) // warm the toplevel cache
    laggingGitOnPath(0.2)
    resetLog()

    const [a, b, c] = await Promise.all([
      gitStatus(repo, first),
      gitStatus(repo, first),
      gitStatus(repo, 'HEAD')
    ])
    // the two `first` callers share a slot (one run + one trailing); the HEAD caller has
    // its own, and gets an answer measured against HEAD
    expect(a[second]).toBe('added')
    expect(b[second]).toBe('added')
    expect(c[second]).toBeUndefined()
    expect(nameStatusDiffs()).toHaveLength(3)
  }, 15_000)
})
