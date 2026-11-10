import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it, expect } from 'vitest'
import type { SessionInfo } from '../../src/shared/types'
import {
  githubVerb,
  GH_JQ_READS_ENV,
  GH_PASSES_THROUGH,
  GH_REFUSED,
  GH_USAGE,
  GH_WRITE_IT_IN_ENGLISH,
  repoFlagOf
} from '../../src/main/agentGithub'

function verb(opts: { out?: string; ok?: boolean; butler?: boolean; cwd?: string } = {}) {
  const ran: { args: string[]; tabId: string; cwd: string }[] = []
  const run = githubVerb({
    run: async (args, tabId, cwd) => {
      ran.push({ args, tabId, cwd })
      return { ok: opts.ok ?? true, out: opts.out ?? 'OPEN' }
    },
    writesInEnglishOnly: () => opts.butler ?? false
  })
  const call = (args: string[]) =>
    run(args, { tabId: 'pty-1', cwd: opts.cwd ?? '/ws/app', session: {} as SessionInfo })
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
    ['co, an alias the owner may have changed', ['co', '1']],
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
    ['-q with its value attached', ['api', 'user', '-qenv.GH_TOKEN']],
    ['-q at the end of a group of short flags', ['api', 'user', '-iq', '$ENV.GH_TOKEN']]
  ])('refuses a %s filter that reads the environment, where the sign-in is', async (_n, args) => {
    const { call, ran } = verb()
    expect(await call(args)).toEqual({ text: GH_JQ_READS_ENV, exit: 1 })
    expect(ran).toEqual([])
  })

  it.each([
    ['git, as repo clone does', ['repo', 'clone', 'o/r', 'x', '--', '--upload-pack=env']],
    ['ssh, as codespace ssh does', ['codespace', 'ssh', '--', '-o', 'ProxyCommand=env']]
  ])(
    'refuses words after -- that gh hands to %s, which runs with the sign-in',
    async (_n, args) => {
      const { call, ran } = verb()
      expect(await call(args)).toEqual({ text: GH_PASSES_THROUGH, exit: 1 })
      expect(ran).toEqual([])
    }
  )

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

  it.each([
    [
      'a Chinese title',
      ['issue', 'create', '--repo', 'a/b', '--title', '搜索框失去焦点', '--body', 'x']
    ],
    ['a Japanese body', ['issue', 'create', '-R', 'a/b', '-t', 'Search', '-b', '検索できません']],
    ['a Korean title given with =', ['pr', 'create', '--title=검색 버그', '--body=x']],
    ['a body file in Chinese', ['issue', 'create', '--title', 'Search', '--body-file', 'body.md']]
  ])(
    'refuses the butler an issue or pull request with %s, asking for English',
    async (_n, args) => {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-gh-'))
      fs.writeFileSync(path.join(cwd, 'body.md'), '输入第一个字以后就失去焦点')
      const { call, ran } = verb({ butler: true, cwd })
      expect(await call(args)).toEqual({ text: GH_WRITE_IT_IN_ENGLISH, exit: 1 })
      expect(ran).toEqual([])
    }
  )

  it('lets the butler open an issue in English, and comment in any language', async () => {
    const { call, ran } = verb({ butler: true })
    expect(
      (await call(['issue', 'create', '--title', 'Search loses focus', '--body', 'x'])).exit
    ).toBe(0)
    expect((await call(['issue', 'comment', '5', '--body', '已决定'])).exit).toBe(0)
    expect(ran).toHaveLength(2)
  })

  it('lets a session in a workspace open an issue in its project’s language', async () => {
    const { call, ran } = verb({ butler: false })
    expect((await call(['issue', 'create', '--title', '搜索框失去焦点', '--body', 'x'])).exit).toBe(
      0
    )
    expect(ran).toHaveLength(1)
  })

  it('finds the repository the butler names, for picking its GitHub account', () => {
    expect(repoFlagOf(['pr', 'list', '--repo', 'a/b'])).toBe('a/b')
    expect(repoFlagOf(['pr', 'list', '--repo=a/b'])).toBe('a/b')
    expect(repoFlagOf(['pr', 'list', '-R', 'a/b'])).toBe('a/b')
    expect(repoFlagOf(['pr', 'list', '-Ra/b'])).toBe('a/b')
    expect(repoFlagOf(['pr', 'list'])).toBeUndefined()
  })
})
