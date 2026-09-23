import { describe, expect, it } from 'vitest'
import {
  filterGitSpawns,
  isAggregateDiff,
  parseGitSpawns,
  WORKBENCH_GIT
} from '../e2e/helpers/gitSpawnLog'

/**
 * The git spawn counter's readers (NFR-02 / WB-C17, WB-K08). Only the PURE halves are
 * here; installing the PATH shim and watching a real app spawn through it is the e2e
 * layer's job.
 *
 * They earn a unit test because both encode a contract with something outside themselves
 * that an e2e failure would report as a vague "the count is wrong":
 *  - `parseGitSpawns` has to agree, byte for byte, with the tab-joining the bash wrapper
 *    does (`IFS=$'\t'; "$*"`);
 *  - `isAggregateDiff` claims a specific argv shape belongs to exactly one caller in the
 *    app. If it also matched the sidebar tree's numstat/name-status reads, WB-K08 would
 *    pass while the panel was busy behind a collapsed panel.
 */

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
  // the split it encodes: these four reach git ONLY through a Workbench read…
  it('matches every subcommand the panel issues', () => {
    for (const sub of ['merge-base', 'diff', 'ls-files', 'check-ignore']) {
      expect(WORKBENCH_GIT.test(sub)).toBe(true)
    }
  })

  // …while these are what main runs on its own timers (gitFreshness sweeps, workspace ops),
  // so counting them would make WB-K08's "zero while collapsed" unreachable
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
