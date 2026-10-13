import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { execFileSync } from 'child_process'
import { GitRepoKeys, repoKeyOf } from '../../src/main/gitRepoKey'

let root: string
let repo: string
let tree: string
let link: string
let plain: string

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, {
    cwd,
    env: { PATH: process.env.PATH, HOME: root, GIT_CONFIG_NOSYSTEM: '1' },
    stdio: 'ignore'
  })
}

beforeAll(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-repokey-')))
  repo = path.join(root, 'repo')
  tree = path.join(root, 'tree')
  link = path.join(root, 'link')
  plain = path.join(root, 'plain')
  fs.mkdirSync(path.join(repo, 'sub'), { recursive: true })
  fs.mkdirSync(plain)
  git(repo, 'init', '-q')
  git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'i')
  git(repo, 'worktree', 'add', '-q', tree)
  fs.symlinkSync(repo, link)
})

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe('repoKeyOf', () => {
  it("is the real path of the repository's .git from its top, a subfolder, a linked worktree and a symlinked path", async () => {
    const key = path.join(repo, '.git')
    for (const ws of [repo, path.join(repo, 'sub'), tree, link])
      expect(await repoKeyOf(ws)).toBe(key)
  })

  it('is null for a folder outside any repository and for a missing folder', async () => {
    expect(await repoKeyOf(plain)).toBeNull()
    expect(await repoKeyOf(path.join(root, 'gone'))).toBeNull()
  })
})

describe('GitRepoKeys', () => {
  it('knows each workspace by its repository, and lists every workspace that shares one', async () => {
    const keys = new GitRepoKeys()
    await keys.refresh([repo, tree, plain])
    expect(keys.known(tree)).toBe(path.join(repo, '.git'))
    expect(keys.known(plain)).toBeNull()
    expect(keys.workspacesOf(path.join(repo, '.git'))).toEqual([repo, tree])
    await keys.refresh([plain])
    expect(keys.known(repo)).toBeNull()
  })
})
