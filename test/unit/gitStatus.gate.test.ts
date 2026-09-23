import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { execFileSync } from 'child_process'
import { gitStatus } from '../../src/main/gitStatus'
import { filterGitSpawns, parseGitSpawns, type GitSpawn } from '../e2e/helpers/gitSpawnLog'
import { gitOnPath, realGit, recordArgv, restorePath, seedRepo } from './helpers/gitShim'

let tmp: string
let repo: string
let log: string
let realGitAnsweredLog: string

function laggingGitOnPath(sleepSecs: number): void {
  gitOnPath(
    tmp,
    `#!/usr/bin/env bash\n` +
      recordArgv(log) +
      `__out=$(mktemp); "${realGit()}" "$@" > "$__out"; __rc=$?\n` +
      `printf '%s\\n' "$__line" >> "${realGitAnsweredLog}"\n` +
      `sleep ${sleepSecs}; cat "$__out"; rm -f "$__out"; exit $__rc\n`
  )
}

const readLog = (file: string): GitSpawn[] =>
  fs.existsSync(file) ? parseGitSpawns(fs.readFileSync(file, 'utf8')) : []

function resetLog(): void {
  fs.rmSync(log, { force: true })
  fs.rmSync(realGitAnsweredLog, { force: true })
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
  realGitAnsweredLog = path.join(tmp, 'git-realGitAnsweredLog.log')
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
    await gitStatus(repo, base)
    laggingGitOnPath(0.2)
    resetLog()

    const results = await Promise.all(Array.from({ length: 5 }, () => gitStatus(repo, base)))
    expect(untrackedListings()).toHaveLength(2)
    for (const r of results) expect(r).toEqual(results[0])

    resetLog()
    await gitStatus(repo, base)
    expect(untrackedListings()).toHaveLength(1)
  }, 15_000)

  it("a caller who arrives mid-run gets the trailing run's answer, which sees the change that woke it", async () => {
    const base = git('rev-parse', 'HEAD')
    await gitStatus(repo, base)
    laggingGitOnPath(0.3)
    resetLog()

    const fresh = path.join(repo, 'fresh.txt')
    const a = gitStatus(repo, base)
    await vi.waitFor(() =>
      expect(readLog(realGitAnsweredLog).some((s) => s.argv.includes('--others'))).toBe(true)
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
    await gitStatus(repo, first)
    laggingGitOnPath(0.2)
    resetLog()

    const [a, b, c] = await Promise.all([
      gitStatus(repo, first),
      gitStatus(repo, first),
      gitStatus(repo, 'HEAD')
    ])
    expect(a[second]).toBe('added')
    expect(b[second]).toBe('added')
    expect(c[second]).toBeUndefined()
    expect(nameStatusDiffs()).toHaveLength(3)
  }, 15_000)
})
