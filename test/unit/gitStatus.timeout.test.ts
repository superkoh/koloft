import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { execFileSync } from 'child_process'
import { gitOnPath, realGit, restorePath, seedRepo } from './helpers/gitShim'

/**
 * Every git this module runs is killed after `GIT_TIMEOUT_MS` and carries
 * GIT_OPTIONAL_LOCKS=0. The cap is a ceiling for a git that never answers (a dead network
 * mount, a sleeping disk), so the cases below hold git open forever and check that the
 * call settles, leaves no process behind, and answers honestly: what git printed before
 * the kill comes back labelled cut off, and a git that printed nothing fails the query
 * instead of letting a fallback answer a different question.
 *
 * The cap is set through the env seam BEFORE the module is imported, so the module's own
 * constant is what is under test.
 */
// generous against a loaded machine: the kill must land AFTER the shim has started
const TIMEOUT_MS = 1000
process.env.KOLOFT_GIT_TIMEOUT_MS = String(TIMEOUT_MS)
const { gitDiff, gitFileDiff, gitNumstat, gitStatus } = await import('../../src/main/gitStatus')

let tmp: string
let repo: string
let pids: string
let envLog: string

/** a `git` that never answers, recording the pid Node will have to kill. `exec` matters:
 *  a bare `sleep` child of the shell would outlive its parent and fake an orphan. */
function hangingGitOnPath(): void {
  gitOnPath(tmp, `#!/bin/sh\nprintf '%s\\n' "$$" >> "${pids}"\nexec sleep 60\n`)
}

/** a `git` that prints part of a diff and then never answers */
function cutOffGitOnPath(text: string): void {
  gitOnPath(tmp, `#!/bin/sh\nprintf '%s\\n' '${text}'\nexec sleep 60\n`)
}

/** a `git` that records the GIT_OPTIONAL_LOCKS it was handed, then delegates */
function envRecordingGitOnPath(): void {
  gitOnPath(
    tmp,
    `#!/usr/bin/env bash\n` +
      `printf '%s\\n' "\${GIT_OPTIONAL_LOCKS-unset}" >> "${envLog}"\n` +
      `exec "${realGit()}" "$@"\n`
  )
}

/** every pid the hanging shim recorded — one line per git Node had to spawn */
const spawnedPids = (): number[] =>
  fs.readFileSync(pids, 'utf8').split('\n').filter(Boolean).map(Number)

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const git = (...args: string[]): string =>
  execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim()

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-gittimeout-')))
  pids = path.join(tmp, 'pids')
  envLog = path.join(tmp, 'env.log')
  repo = path.join(tmp, 'work')
  seedRepo(repo)
})

afterEach(() => {
  restorePath()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('the git timeout', () => {
  it('a git that never answers is killed after GIT_TIMEOUT_MS: the call settles and no process is left behind', async () => {
    const base = git('rev-parse', 'HEAD')
    await gitNumstat(repo, base) // warm the toplevel cache with a real git
    hangingGitOnPath()

    const t0 = Date.now()
    await expect(gitNumstat(repo, base)).rejects.toThrow()
    expect(Date.now() - t0).toBeLessThan(TIMEOUT_MS + 1000)

    // just the numstat: the fresh-repo fallback counts different lines, so a killed git
    // must not be answered with it
    const [pid, ...rest] = spawnedPids()
    expect(rest).toEqual([])
    await vi.waitFor(() => expect(alive(pid)).toBe(false))
  }, 15_000)

  it('an aggregate diff cut off by the timeout is handed back labelled truncated', async () => {
    const base = git('rev-parse', 'HEAD')
    await gitDiff(repo, base) // warm the toplevel cache
    cutOffGitOnPath('diff --git a/tracked.txt b/tracked.txt')

    const r = await gitDiff(repo, base)
    expect(r.text).toContain('diff --git')
    expect(r.truncated).toBe(true)
    expect(r.notRepo).toBe(false)
  })

  it('a --no-index diff cut off by the timeout is labelled truncated too, not presented as complete', async () => {
    const base = git('rev-parse', 'HEAD')
    const fresh = path.join(repo, 'fresh.txt')
    fs.writeFileSync(fresh, 'new\n')
    await gitFileDiff(fresh, base, true) // warm the toplevel cache
    cutOffGitOnPath('diff --git a/dev/null b/fresh.txt')

    const r = await gitFileDiff(fresh, base, true)
    expect(r.text).toContain('diff --git')
    expect(r.truncated).toBe(true)
  })

  it('every git the panel runs carries GIT_OPTIONAL_LOCKS=0, so it never takes index.lock', async () => {
    const base = git('rev-parse', 'HEAD')
    const fresh = path.join(repo, 'fresh.txt')
    fs.writeFileSync(fresh, 'new\n')
    envRecordingGitOnPath()

    await gitStatus(repo, base)
    await gitFileDiff(fresh, base, true)

    const lines = fs.readFileSync(envLog, 'utf8').split('\n').filter(Boolean)
    expect(lines.length).toBeGreaterThan(0)
    expect(lines.every((l) => l === '0')).toBe(true)
  })

  it('a git killed before it printed anything fails the diff instead of calling it empty', async () => {
    const base = git('rev-parse', 'HEAD')
    await gitDiff(repo, base) // warm the toplevel cache
    hangingGitOnPath()

    // the stream shows its "git unresponsive — retry" state only on a rejection; the
    // fresh-repo fallback would answer a different question (staged + unstaged), and an
    // empty diff is read as "nothing has changed"
    await expect(gitDiff(repo, base)).rejects.toThrow()
    expect(spawnedPids()).toHaveLength(1)
  })

  it('a status whose base diff was killed fails instead of asking about HEAD', async () => {
    const base = git('rev-parse', 'HEAD')
    await gitStatus(repo, base) // warm the toplevel cache
    hangingGitOnPath()

    // the three listings and nothing behind them: `git status --porcelain` measures
    // against HEAD, which drops every change already committed on the branch — and a
    // rejection is what keeps the panel's last good map (an empty one would replace it)
    await expect(gitStatus(repo, base)).rejects.toThrow()
    expect(spawnedPids()).toHaveLength(3)
  })

  it('a per-file diff whose base diff was killed fails at that rung, not three probes later', async () => {
    const base = git('rev-parse', 'HEAD')
    const tracked = path.join(repo, 'tracked.txt')
    await gitFileDiff(tracked, base) // warm the toplevel cache
    hangingGitOnPath()

    await expect(gitFileDiff(tracked, base)).rejects.toThrow()
    expect(spawnedPids()).toHaveLength(1)
  })
})
