import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { execFileSync } from 'child_process'
import { gitFileDiff, gitFileDiffFull, gitNumstat, gitStatus } from '../../src/main/gitStatus'
import { filterGitSpawns, parseGitSpawns, type GitSpawn } from '../e2e/helpers/gitSpawnLog'
import { gitOnPath, realGit, recordArgv, restorePath, seedRepo } from './helpers/gitShim'

let tmp: string
let repo: string
let log: string

function recordingGitOnPath(): void {
  gitOnPath(tmp, `#!/usr/bin/env bash\n` + recordArgv(log) + `exec "${realGit()}" "$@"\n`)
}

function spawns(): GitSpawn[] {
  return fs.existsSync(log) ? parseGitSpawns(fs.readFileSync(log, 'utf8')) : []
}

function resetLog(): void {
  fs.rmSync(log, { force: true })
}

const subcommands = (): (string | null)[] => spawns().map((s) => s.subcommand)

const git = (...args: string[]): string =>
  execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim()

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-gitspawns-')))
  log = path.join(tmp, 'git-calls.log')
  repo = path.join(tmp, 'work')
  seedRepo(repo)
})

afterEach(() => {
  restorePath()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('the untracked fast path (gitFileDiff / gitFileDiffFull, untracked: true)', () => {
  it('spawns at most two processes and answers exactly what the probed path answers', async () => {
    const file = path.join(repo, 'fresh.txt')
    fs.writeFileSync(file, 'brand new\n')
    const base = git('rev-parse', 'HEAD')
    recordingGitOnPath()

    resetLog()
    const fast = await gitFileDiff(file, base, true)
    expect(subcommands()).toEqual(['rev-parse', 'diff'])
    expect(spawns().length).toBeLessThanOrEqual(2)

    resetLog()
    expect(await gitFileDiff(file, base, true)).toEqual(fast)
    expect(subcommands()).toEqual(['diff'])

    resetLog()
    const slow = await gitFileDiff(file, base)
    expect(subcommands()).toEqual(['diff', 'ls-files', 'check-ignore', 'diff'])

    expect(fast).toEqual(slow)
    expect(fast.text).toContain('+brand new')
    expect(fast.truncated).toBe(false)
  })

  it('gitFileDiffFull agrees the same way, for a file below the toplevel', async () => {
    const dir = path.join(repo, 'sub')
    fs.mkdirSync(dir)
    const file = path.join(dir, 'fresh.txt')
    fs.writeFileSync(file, 'one\ntwo\n')
    const base = git('rev-parse', 'HEAD')
    recordingGitOnPath()

    resetLog()
    const fast = await gitFileDiffFull(file, base, true)
    expect(spawns().length).toBeLessThanOrEqual(2)
    const slow = await gitFileDiffFull(file, base)
    expect(fast).toEqual(slow)
    expect(fast.text).toContain('+++ b/sub/fresh.txt')
    expect(fast.text).toContain('+one\n+two\n')
  })

  it('does not resolve a base it will never use', async () => {
    const file = path.join(repo, 'fresh.txt')
    fs.writeFileSync(file, 'brand new\n')
    recordingGitOnPath()
    resetLog()
    expect((await gitFileDiff(file, undefined, true)).text).toContain('+brand new')
    expect(filterGitSpawns(spawns(), { subcommand: /^(merge-base|symbolic-ref)$/ })).toHaveLength(0)
  })

  it('shows an IGNORED file when asked for as untracked — the probed path suppresses it', async () => {
    fs.writeFileSync(path.join(repo, '.gitignore'), 'secret.env\n')
    const file = path.join(repo, 'secret.env')
    fs.writeFileSync(file, 'TOKEN=1\n')
    const base = git('rev-parse', 'HEAD')
    expect((await gitFileDiff(file, base)).text).toBe('')
    expect((await gitFileDiff(file, base, true)).text).toContain('+TOKEN=1')
  })

  it('honours only the literal true — a tracked, unmodified file stays empty under anything else', async () => {
    const file = path.join(repo, 'tracked.txt')
    const base = git('rev-parse', 'HEAD')
    expect((await gitFileDiff(file, base, 'true' as unknown as boolean)).text).toBe('')
    expect((await gitFileDiff(file, base, 1 as unknown as boolean)).text).toBe('')
    expect((await gitFileDiff(file, base, undefined)).text).toBe('')
  })
})

describe('the toplevel cache', () => {
  it('asks rev-parse --show-toplevel once for a root, across gitStatus and gitNumstat alike', async () => {
    const base = git('rev-parse', 'HEAD')
    recordingGitOnPath()
    resetLog()
    await gitStatus(repo, base)
    await Promise.all([gitStatus(repo, base), gitNumstat(repo, base)])
    await Promise.all([gitStatus(repo, base), gitNumstat(repo, base)])
    const lookups = filterGitSpawns(spawns(), {
      root: repo,
      argv: (a) => a.includes('--show-toplevel')
    })
    expect(lookups).toHaveLength(1)
  })

  it('re-asks when the root is gone, and does not cache the refusal', async () => {
    const base = git('rev-parse', 'HEAD')
    await gitStatus(repo, base)
    fs.rmSync(repo, { recursive: true, force: true })
    recordingGitOnPath()
    resetLog()
    expect(await gitStatus(repo, base)).toEqual({})
    expect(await gitStatus(repo, base)).toEqual({})
    expect(subcommands()).toEqual(['rev-parse', 'rev-parse'])
  })

  it('re-asks when a nested repo appears between the root and the toplevel — git picks the nearest', async () => {
    const sub = path.join(repo, 'sub')
    fs.mkdirSync(sub)
    fs.writeFileSync(path.join(sub, 'inner.txt'), 'new\n')
    fs.writeFileSync(path.join(repo, 'outer.txt'), 'new\n')
    recordingGitOnPath()
    resetLog()

    const before = await gitStatus(sub, 'HEAD')
    expect(before[path.join(repo, 'outer.txt')]).toBe('untracked')
    expect(before[path.join(sub, 'inner.txt')]).toBe('untracked')

    execFileSync('git', ['init', '-q', sub], { stdio: 'ignore' })
    const after = await gitStatus(sub, 'HEAD')
    expect(after[path.join(repo, 'outer.txt')]).toBeUndefined()
    expect(after[path.join(sub, 'inner.txt')]).toBe('untracked')
    expect(
      filterGitSpawns(spawns(), { root: sub, argv: (a) => a.includes('--show-toplevel') })
    ).toHaveLength(2)
  })

  it('keeps trusting a hit across a .git deleted and recreated at the same path — the answer is unchanged', async () => {
    const base = git('rev-parse', 'HEAD')
    await gitStatus(repo, base)
    fs.rmSync(path.join(repo, '.git'), { recursive: true, force: true })
    execFileSync('git', ['init', '-q', '-b', 'main', repo], { stdio: 'ignore' })
    recordingGitOnPath()
    resetLog()
    const status = await gitStatus(repo, 'HEAD')
    expect(status[path.join(repo, 'tracked.txt')]).toBe('untracked')
    expect(filterGitSpawns(spawns(), { argv: (a) => a.includes('--show-toplevel') })).toHaveLength(
      0
    )
  })
})

describe('gitNumstat argv', () => {
  it('terminates with `--` like every other diff, so the base can never start a pathspec', async () => {
    const base = git('rev-parse', 'HEAD')
    recordingGitOnPath()
    resetLog()
    await gitNumstat(repo, base)
    const numstat = filterGitSpawns(spawns(), { argv: (a) => a.includes('--numstat') })
    expect(numstat).toHaveLength(1)
    expect(numstat[0].argv.at(-1)).toBe('--')
  })
})
