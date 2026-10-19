import { describe, it, expect } from 'vitest'
import type { SessionInfo } from '../../src/shared/types'
import {
  githubVerb,
  GH_JQ_READS_ENV,
  GH_REFUSED,
  GH_USAGE,
  repoFlagOf
} from '../../src/main/agentGithub'

function verb(opts: { out?: string; ok?: boolean } = {}) {
  const ran: { args: string[]; tabId: string; cwd: string }[] = []
  const run = githubVerb({
    run: async (args, tabId, cwd) => {
      ran.push({ args, tabId, cwd })
      return { ok: opts.ok ?? true, out: opts.out ?? 'OPEN' }
    }
  })
  const call = (args: string[]) =>
    run(args, { tabId: 'pty-1', cwd: '/ws/app', session: {} as SessionInfo })
  return { call, ran }
}

describe('koloft gh', () => {
  it.each([
    ['a read', ['pr', 'view', '389', '--json', 'state']],
    ['a merge', ['pr', 'merge', '389', '--squash']],
    ['a comment', ['issue', 'comment', '5', '--body', 'x']],
    ['gh api', ['api', 'repos/a/b']]
  ])('runs %s as it is, where the session runs, and prints what gh said', async (_n, args) => {
    const { call, ran } = verb({ out: 'done' })
    expect(await call(args)).toEqual({ text: 'done', exit: 0 })
    expect(ran).toEqual([{ args, tabId: 'pty-1', cwd: '/ws/app' }])
  })

  it.each([
    ['gh auth, which can print the token or sign the owner out', ['auth', 'token']],
    ['gh alias, which can run gh auth under another name', ['alias', 'set', 'x', 'auth token']],
    ['gh extension, which runs any program with the sign-in', ['extension', 'exec', 'x']],
    ['gh ext, its short name', ['ext', 'install', 'evil/gh-x']],
    ['an installed extension or an alias called by its name', ['x']],
    ['gh config, which can name a browser gh starts', ['config', 'set', 'browser', 'sh']],
    ['gh copilot, an agent of its own', ['copilot', 'suggest', 'x']]
  ])('refuses %s without running gh', async (_n, args) => {
    const { call, ran } = verb()
    expect(await call(args)).toEqual({ text: GH_REFUSED, exit: 1 })
    expect(ran).toEqual([])
  })

  it.each([
    ['--jq', ['pr', 'view', '1', '--json', 'url', '--jq', '$ENV.GH_TOKEN']],
    ['--jq=', ['api', 'user', '--jq=env.GH_TOKEN']],
    ['-q', ['api', 'user', '-q', 'env']],
    ['-q with its value attached', ['api', 'user', '-qenv.GH_TOKEN']]
  ])('refuses a %s filter that reads the environment, where the sign-in is', async (_n, args) => {
    const { call, ran } = verb()
    expect(await call(args)).toEqual({ text: GH_JQ_READS_ENV, exit: 1 })
    expect(ran).toEqual([])
  })

  it('lets a --jq filter read a field whose name only contains env', async () => {
    const { call, ran } = verb()
    const args = ['run', 'view', '7', '--json', 'jobs', '--jq', '.jobs[].environment']
    expect((await call(args)).exit).toBe(0)
    expect(ran).toHaveLength(1)
  })

  it('refuses no command at all', async () => {
    const { call, ran } = verb()
    expect(await call([])).toEqual({ text: GH_USAGE, exit: 2 })
    expect(await call(['--version'])).toEqual({ text: GH_USAGE, exit: 2 })
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

  it('finds the repository the butler names, for picking its GitHub account', () => {
    expect(repoFlagOf(['pr', 'list', '--repo', 'a/b'])).toBe('a/b')
    expect(repoFlagOf(['pr', 'list', '--repo=a/b'])).toBe('a/b')
    expect(repoFlagOf(['pr', 'list', '-R', 'a/b'])).toBe('a/b')
    expect(repoFlagOf(['pr', 'list', '-Ra/b'])).toBe('a/b')
    expect(repoFlagOf(['pr', 'list'])).toBeUndefined()
  })
})
