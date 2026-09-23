import { afterEach, describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { execFileSync } from 'child_process'
import {
  filterGitSpawns,
  installGitSpawnLog,
  isAggregateDiff,
  parseGitSpawns,
  WORKBENCH_GIT
} from '../e2e/helpers/gitSpawnLog'
import type { E2EEnv } from '../e2e/helpers/env'
import { GitFreshnessEngine } from '../../src/main/gitFreshness'

const SHA = '41bc8cd5b57f78e76e57ee127ce63d489203cccc'
const ROOT = '/private/tmp/koloft-e2e-home-x/ws-a'
const line = (...argv: string[]): string => argv.join('\t')

describe('parseGitSpawns', () => {
  it('restores argv from the wrapper’s tab join, and reads `-C <root> <sub>`', () => {
    const [call] = parseGitSpawns(line('-C', ROOT, 'merge-base', 'HEAD', 'main') + '\n')
    expect(call.argv).toEqual(['-C', ROOT, 'merge-base', 'HEAD', 'main'])
    expect(call.root).toBe(ROOT)
    expect(call.subcommand).toBe('merge-base')
  })

  it('leaves root null for a call with no `-C` — the hand-typed shell shape WB-K08 excludes', () => {
    const [call] = parseGitSpawns(line('status', '--porcelain'))
    expect(call.root).toBeNull()
    expect(call.subcommand).toBe('status')
  })

  it('skips leading flags when there is no `-C`, so `git --no-pager diff` is still a diff', () => {
    const [call] = parseGitSpawns(line('--no-pager', 'diff'))
    expect(call.subcommand).toBe('diff')
  })

  it('ignores blank lines — an absent trailing newline must not become a phantom spawn', () => {
    expect(parseGitSpawns('')).toEqual([])
    expect(parseGitSpawns('\n\n')).toEqual([])
    expect(parseGitSpawns(line('-C', ROOT, 'status') + '\n\n')).toHaveLength(1)
  })

  it('keeps a path containing a space intact — only tabs separate argv', () => {
    const spaced = `${ROOT}/my docs`
    const [call] = parseGitSpawns(line('-C', spaced, 'diff', SHA, '--'))
    expect(call.root).toBe(spaced)
  })
})

describe('filterGitSpawns', () => {
  const calls = parseGitSpawns(
    [
      line('-C', ROOT, 'merge-base', 'HEAD', 'main'),
      line('-C', ROOT, 'diff', '--name-status', '-z', SHA, '--'),
      line('-C', '/other/ws', 'merge-base', 'HEAD', 'main'),
      line('-C', ROOT, 'status', '--porcelain=v1', '-z'),
      line('status')
    ].join('\n')
  )

  it('scopes to one workspace', () => {
    expect(filterGitSpawns(calls, { root: ROOT })).toHaveLength(3)
  })

  it('matches a subcommand by string and by regex', () => {
    expect(filterGitSpawns(calls, { subcommand: 'merge-base' })).toHaveLength(2)
    expect(filterGitSpawns(calls, { subcommand: /^(diff|status)$/ })).toHaveLength(3)
  })

  it('ANDs its terms — the before/after delta both NFR cases take is per root AND per sub', () => {
    expect(filterGitSpawns(calls, { root: ROOT, subcommand: 'merge-base' })).toHaveLength(1)
  })

  it('honors an argv predicate, which is the only term that can say WHICH caller', () => {
    expect(filterGitSpawns(calls, { argv: (a) => a.includes('--name-status') })).toHaveLength(1)
  })

  it('an empty filter is everything, the log itself included', () => {
    expect(filterGitSpawns(calls)).toHaveLength(5)
  })
})

describe('WORKBENCH_GIT', () => {
  it('matches every subcommand the panel issues', () => {
    for (const sub of ['merge-base', 'diff', 'ls-files', 'check-ignore']) {
      expect(WORKBENCH_GIT.test(sub)).toBe(true)
    }
  })

  it('matches nothing the freshness engine or workspace ops issue', () => {
    for (const sub of ['rev-parse', 'symbolic-ref', 'status', 'rev-list', 'fetch', 'pull']) {
      expect(WORKBENCH_GIT.test(sub)).toBe(false)
    }
  })

  it('is anchored — `diff-tree` and `merge` must not slip through', () => {
    expect(WORKBENCH_GIT.test('diff-tree')).toBe(false)
    expect(WORKBENCH_GIT.test('merge')).toBe(false)
  })

  it('reads as a filter over a real log', () => {
    const calls = parseGitSpawns(
      [
        line('-C', ROOT, 'merge-base', 'HEAD', 'main'),
        line('-C', ROOT, 'rev-list', '--left-right', '--count', 'HEAD...origin/main'),
        line('-C', ROOT, 'check-ignore', '--', 'node_modules')
      ].join('\n')
    )
    expect(filterGitSpawns(calls, { root: ROOT, subcommand: WORKBENCH_GIT })).toHaveLength(2)
  })
})

describe('WORKBENCH_GIT against the freshness engine’s real spawns', () => {
  const realPath = process.env.PATH
  let tmp = ''

  afterEach(() => {
    process.env.PATH = realPath
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  const git = (cwd: string, ...args: string[]): string =>
    execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' })

  function commitIn(repo: string, name: string): void {
    fs.writeFileSync(path.join(repo, name), name + '\n')
    git(repo, 'add', name)
    git(repo, '-c', 'user.email=t@t.com', '-c', 'user.name=t', 'commit', '-q', '-m', name)
  }

  it('the freshness sweep, fetch and pull spawn none of the Workbench-only subcommands, or a WORKBENCH_GIT count would stop meaning the Workbench ran git', async () => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-spawnlog-')))
    const seed = path.join(tmp, 'seed')
    execFileSync('git', ['init', '-q', '-b', 'main', seed])
    commitIn(seed, 'a.txt')
    const origin = path.join(tmp, 'origin.git')
    execFileSync('git', ['clone', '-q', '--bare', seed, origin])
    const work = path.join(tmp, 'work')
    execFileSync('git', ['clone', '-q', origin, work])
    commitIn(seed, 'b.txt')
    git(seed, 'push', '-q', origin, 'main')

    const fakeBin = path.join(tmp, 'bin')
    fs.mkdirSync(fakeBin)
    const gitCalls = path.join(tmp, 'git-calls.txt')
    installGitSpawnLog({
      fakeBin,
      gitCalls,
      shimDir: fakeBin,
      launchEnv: { PATH: realPath }
    } as unknown as E2EEnv)
    process.env.PATH = `${fakeBin}:${realPath}`

    const engine = new GitFreshnessEngine({
      workspaces: () => [{ path: work, missing: false }],
      autoFetch: () => true,
      onChange: () => {}
    })
    await engine.sweep()
    const before = await engine.fetchNow(work)
    expect(before?.behind).toBe(1)
    const pulled = await engine.pull(work, { branch: before!.branch, head: before!.head })
    expect(pulled.ok).toBe(true)

    const calls = parseGitSpawns(fs.readFileSync(gitCalls, 'utf8'))
    expect(filterGitSpawns(calls, { root: work, subcommand: 'fetch' }).length).toBeGreaterThan(0)
    expect(filterGitSpawns(calls, { root: work, argv: (a) => a.includes('pull') })).toHaveLength(1)
    expect(filterGitSpawns(calls, { subcommand: WORKBENCH_GIT })).toEqual([])
  })
})

describe('isAggregateDiff', () => {
  it('accepts the Workbench’s own shape: `-C <root> diff <rev> --`', () => {
    expect(isAggregateDiff(['-C', ROOT, 'diff', SHA, '--'])).toBe(true)
    expect(isAggregateDiff(['-C', ROOT, 'diff', 'HEAD', '--'])).toBe(true)
  })

  it('rejects the sidebar tree’s reads — those are the calls WB-K08 must not count', () => {
    expect(isAggregateDiff(['-C', ROOT, 'diff', '--name-status', '-z', SHA, '--'])).toBe(false)
    expect(isAggregateDiff(['-C', ROOT, 'diff', SHA, '--numstat', '-z'])).toBe(false)
    expect(isAggregateDiff(['-C', ROOT, 'merge-base', 'HEAD', 'main'])).toBe(false)
  })

  it('rejects a per-FILE diff: a pathspec after the `--` is a viewer read, not the stream', () => {
    expect(isAggregateDiff(['-C', ROOT, 'diff', SHA, '--', `${ROOT}/src/a.ts`])).toBe(false)
    expect(
      isAggregateDiff(['-C', ROOT, 'diff', '-U1000000000', SHA, '--', `${ROOT}/src/a.ts`])
    ).toBe(false)
  })

  it('rejects the fresh-repo fallbacks, which carry a flag where the rev would be', () => {
    expect(isAggregateDiff(['-C', ROOT, 'diff', '--cached', '--'])).toBe(false)
    expect(isAggregateDiff(['-C', ROOT, 'diff', '--'])).toBe(false)
  })

  it('rejects anything without the `-C` form — a git typed into a terminal tab', () => {
    expect(isAggregateDiff(['diff', SHA, '--'])).toBe(false)
  })
})
