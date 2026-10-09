import { describe, it, expect } from 'vitest'
import type { SessionInfo } from '../../src/shared/types'
import {
  githubVerb,
  GH_NEEDS_A_REPO,
  GH_ONLY_A_CONDUCTOR,
  GH_USAGE
} from '../../src/main/agentGithub'

function verb(opts: { scope?: string; repo?: string | null; out?: string; ok?: boolean } = {}) {
  const ran: string[][] = []
  const run = githubVerb({
    scopeOf: () => ('scope' in opts ? opts.scope : '/ws/app'),
    repoOf: async () => ('repo' in opts ? (opts.repo ?? null) : 'octo/app'),
    run: async (args) => {
      ran.push(args)
      return { ok: opts.ok ?? true, out: opts.out ?? 'OPEN' }
    }
  })
  const call = (args: string[]) =>
    run(args, { tabId: 'pty-1', cwd: '/c', session: {} as SessionInfo })
  return { call, ran }
}

describe('koloft gh', () => {
  it('runs a read with the workspace’s repository filled in and prints what gh said', async () => {
    const { call, ran } = verb({ out: '{"state":"MERGED"}' })
    expect(await call(['pr', 'view', '389', '--json', 'state'])).toEqual({
      text: '{"state":"MERGED"}',
      exit: 0
    })
    expect(ran).toEqual([['pr', 'view', '389', '--json', 'state', '--repo', 'octo/app']])
  })

  it.each([
    ['--repo given', ['issue', 'list', '--repo', 'a/b']],
    ['--repo= given', ['run', 'list', '--repo=a/b']],
    ['a full URL', ['pr', 'checks', 'https://github.com/a/b/pull/3']]
  ])('leaves the repository alone with %s, even for the global conductor', async (_n, args) => {
    const { call, ran } = verb({ repo: null })
    expect((await call(args)).exit).toBe(0)
    expect(ran).toEqual([args])
  })

  it('asks the global conductor for --repo when nothing names one', async () => {
    const { call, ran } = verb({ repo: null })
    expect(await call(['pr', 'list'])).toEqual({ text: GH_NEEDS_A_REPO, exit: 1 })
    expect(ran).toEqual([])
  })

  it.each([
    ['a command that writes', ['pr', 'merge', '389']],
    ['a comment', ['issue', 'comment', '5', '--body', 'x']],
    ['gh api', ['api', 'repos/a/b', '-X', 'DELETE']],
    ['a jq filter that can read the environment', ['pr', 'view', '1', '--jq', '$ENV']],
    ['a flag outside the list, given with =', ['pr', 'view', '1', '--web=true']],
    ['no command', []]
  ])('refuses %s without running gh', async (_n, args) => {
    const { call, ran } = verb()
    expect(await call(args)).toEqual({ text: GH_USAGE, exit: 2 })
    expect(ran).toEqual([])
  })

  it('is refused to a session that is not a conductor', async () => {
    const { call, ran } = verb({ scope: undefined })
    expect(await call(['pr', 'view', '1'])).toEqual({ text: GH_ONLY_A_CONDUCTOR, exit: 1 })
    expect(ran).toEqual([])
  })

  it('passes on what gh said when it fails', async () => {
    const { call } = verb({ ok: false, out: 'no pull requests found' })
    expect(await call(['pr', 'view', '9'])).toEqual({
      text: 'koloft: gh pr view: no pull requests found',
      exit: 1
    })
  })

  it('cuts a very long answer and says how to ask for less', async () => {
    const { call } = verb({ out: 'x'.repeat(50_000) })
    const { text, exit } = await call(['run', 'view', '7', '--log-failed'])
    expect(exit).toBe(0)
    expect(text.length).toBeLessThan(21_000)
    expect(text).toMatch(/cut at \d+ characters; ask for less/)
  })
})
