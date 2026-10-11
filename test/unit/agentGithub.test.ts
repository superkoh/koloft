import { describe, it, expect } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { SessionInfo } from '../../src/shared/types'
import {
  githubVerb,
  GH_BODY_FILE_OUTSIDE_OWN_FOLDER,
  GH_NEEDS_A_REPO,
  GH_ONLY_A_CONDUCTOR,
  GH_USAGE
} from '../../src/main/agentGithub'

function verb(
  opts: { scope?: string; repo?: string | null; out?: string; ok?: boolean; folder?: string } = {}
) {
  const ran: string[][] = []
  const folder = opts.folder ?? '/c'
  const run = githubVerb({
    scopeOf: () => ('scope' in opts ? opts.scope : '/ws/app'),
    folderOf: () => folder,
    repoOf: async () => ('repo' in opts ? (opts.repo ?? null) : 'octo/app'),
    run: async (args) => {
      ran.push(args)
      return { ok: opts.ok ?? true, out: opts.out ?? 'OPEN' }
    }
  })
  const call = (args: string[]) =>
    run(args, { tabId: 'pty-1', cwd: folder, session: {} as SessionInfo })
  return { call, ran }
}

function conductorFolderWithAFileBeside(): { folder: string; inside: string; outside: string } {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-gh-')))
  const folder = path.join(root, 'conductor')
  fs.mkdirSync(folder)
  const inside = path.join(folder, 'body.md')
  const outside = path.join(root, 'secret.txt')
  fs.writeFileSync(inside, 'body')
  fs.writeFileSync(outside, 'secret')
  return { folder, inside, outside }
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
    ['an issue created with an assignee', ['issue', 'create', '--title', 't', '--assignee', 'a']],
    ['an issue created with a word that is no flag', ['issue', 'create', '5', '--title', 't']],
    ['an issue created with a flag left without its value', ['issue', 'create', '--title']],
    ['gh api', ['api', 'repos/a/b', '-X', 'DELETE']],
    ['a jq filter that can read the environment', ['pr', 'view', '1', '--jq', '$ENV']],
    ['a flag outside the list, given with =', ['pr', 'view', '1', '--web=true']],
    ['no command', []]
  ])('refuses %s without running gh', async (_n, args) => {
    const { call, ran } = verb()
    expect(await call(args)).toEqual({ text: GH_USAGE, exit: 2 })
    expect(ran).toEqual([])
  })

  it('opens an issue with the workspace’s repository filled in, a body that starts with a dash kept as the body, and prints its address', async () => {
    const { call, ran } = verb({ out: 'https://github.com/octo/app/issues/7\n' })
    expect(
      await call([
        'issue',
        'create',
        '--title',
        'Login stays blank',
        '--body',
        '- open /login\n- it stays white',
        '--label=bug'
      ])
    ).toEqual({ text: 'https://github.com/octo/app/issues/7\n', exit: 0 })
    expect(ran).toEqual([
      [
        'issue',
        'create',
        '--title=Login stays blank',
        '--body=- open /login\n- it stays white',
        '--label=bug',
        '--repo',
        'octo/app'
      ]
    ])
  })

  it('opens an issue in the repository the global conductor names, and asks for one when it names none', async () => {
    const { call, ran } = verb({ repo: null })
    expect(await call(['issue', 'create', '--title', 't', '--body', 'b'])).toEqual({
      text: GH_NEEDS_A_REPO,
      exit: 1
    })
    expect(
      (await call(['issue', 'create', '--repo', 'a/b', '--title', 't', '--body', 'b'])).exit
    ).toBe(0)
    expect(ran).toEqual([['issue', 'create', '--repo=a/b', '--title=t', '--body=b']])
  })

  it('reads --body-file from the conductor’s own folder, given relative to where it runs', async () => {
    const { folder, inside } = conductorFolderWithAFileBeside()
    const { call, ran } = verb({ folder })
    expect((await call(['issue', 'create', '--title', 't', '--body-file', 'body.md'])).exit).toBe(0)
    expect(ran).toEqual([
      ['issue', 'create', '--title=t', `--body-file=${inside}`, '--repo', 'octo/app']
    ])
  })

  type Folder = ReturnType<typeof conductorFolderWithAFileBeside>
  it.each([
    ['a file outside the conductor’s own folder', (f: Folder) => f.outside],
    ['a way out of the folder through ..', () => '../secret.txt'],
    [
      'a link in the folder that points outside it',
      (f: Folder) => {
        fs.symlinkSync(f.outside, path.join(f.folder, 'link.md'))
        return 'link.md'
      }
    ],
    ['standard input', () => '-']
  ])('refuses --body-file naming %s without running gh', async (_n, pick) => {
    const f = conductorFolderWithAFileBeside()
    const { call, ran } = verb({ folder: f.folder })
    expect(await call(['issue', 'create', '--title', 't', '--body-file', pick(f)])).toEqual({
      text: GH_BODY_FILE_OUTSIDE_OWN_FOLDER,
      exit: 1
    })
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
