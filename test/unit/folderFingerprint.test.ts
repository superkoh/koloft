import fs from 'fs'
import os from 'os'
import path from 'path'
import { execFileSync } from 'child_process'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { localGitOut } from '../../src/main/host/localHost'
import { folderFingerprint } from '../../src/core/folderFingerprint'
import type { GitOut } from '../../src/core/worktree'

let directory: string
let repo: string

function git(...args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim()
}

const write = (file: string, text: string): void => {
  fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true })
  fs.writeFileSync(path.join(repo, file), text)
}

const fingerprint = (dir = repo): Promise<string | null> => folderFingerprint(localGitOut, dir)

beforeEach(() => {
  directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-fingerprint-')))
  repo = path.join(directory, 'repo')
  fs.mkdirSync(repo)
  git('init', '-q', '--initial-branch=main')
  git('config', 'user.name', 'Fingerprint test')
  git('config', 'user.email', 'test@example.invalid')
  write('.gitignore', 'ignored/\n.env\n')
  write('src/app.ts', 'one\n')
  write('README.md', 'readme\n')
  git('add', '.')
  git('commit', '-q', '-m', 'first')
  write('src/app.ts', 'one\ntwo\n')
  write('notes.txt', 'mine\n')
})

afterEach(() => {
  fs.rmSync(directory, { recursive: true, force: true })
})

describe('folderFingerprint', () => {
  it('stays the same while nothing in the folder changes', async () => {
    expect(await fingerprint()).toBe(await fingerprint())
  })

  it('changes when a file that was already changed is changed again', async () => {
    const before = await fingerprint()
    write('src/app.ts', 'one\ntwo\nthree\n')
    expect(await fingerprint()).not.toBe(before)
  })

  it('changes when the words of a file nobody added to git change', async () => {
    const before = await fingerprint()
    write('notes.txt', 'someone else\n')
    expect(await fingerprint()).not.toBe(before)
  })

  it('changes when a new file appears that git does not ignore', async () => {
    const before = await fingerprint()
    write('report/coverage.txt', '90%\n')
    expect(await fingerprint()).not.toBe(before)
  })

  it('is the same again once a change is put back as it was', async () => {
    const before = await fingerprint()
    write('src/app.ts', 'changed for a moment\n')
    write('src/app.ts', 'one\ntwo\n')
    expect(await fingerprint()).toBe(before)
  })

  it('changes on a commit, a new branch, a tag and a stash', async () => {
    const seen = new Set([await fingerprint()])
    git('branch', 'side')
    seen.add(await fingerprint())
    git('tag', 'v1')
    seen.add(await fingerprint())
    git('stash', 'push', '-q', '--', 'src/app.ts')
    seen.add(await fingerprint())
    git('add', 'notes.txt')
    git('commit', '-q', '-m', 'notes')
    seen.add(await fingerprint())
    expect(seen.size).toBe(5)
  })

  it('changes when only what is staged changes, or only a file’s mode', async () => {
    write('src/app.ts', 'staged once\n')
    git('add', 'src/app.ts')
    write('src/app.ts', 'in the folder\n')
    const before = await fingerprint()
    write('src/app.ts', 'staged twice\n')
    git('add', 'src/app.ts')
    write('src/app.ts', 'in the folder\n')
    const restaged = await fingerprint()
    expect(restaged).not.toBe(before)
    fs.chmodSync(path.join(repo, 'src/app.ts'), 0o755)
    expect(await fingerprint()).not.toBe(restaged)
  })

  it('changes when an older stash is dropped', async () => {
    git('stash', 'push', '-q', '--', 'src/app.ts')
    write('src/app.ts', 'again\n')
    git('stash', 'push', '-q', '--', 'src/app.ts')
    const before = await fingerprint()
    git('stash', 'drop', '-q', 'stash@{1}')
    expect(await fingerprint()).not.toBe(before)
  })

  it('answers nothing when reading the commit fails in a repository that has one', async () => {
    const failsOnHead: GitOut = (dir, args, ...rest) =>
      args.includes('HEAD') && args[0] === 'rev-parse'
        ? Promise.resolve(null)
        : localGitOut(dir, args, ...rest)
    expect(await folderFingerprint(failsOnHead, repo)).toBeNull()
  })

  it('does not change when a file git ignores changes', async () => {
    const before = await fingerprint()
    write('.env', 'SECRET=1\n')
    write('ignored/build.js', 'built\n')
    expect(await fingerprint()).toBe(before)
  })

  it('does not change when a fetch moves a remote branch', async () => {
    const before = await fingerprint()
    git('update-ref', 'refs/remotes/origin/main', 'HEAD')
    expect(await fingerprint()).toBe(before)
  })

  it('still answers once a file is deleted or renamed, and changes when it is', async () => {
    const before = await fingerprint()
    fs.rmSync(path.join(repo, 'README.md'))
    const deleted = await fingerprint()
    expect(deleted).not.toBeNull()
    expect(deleted).not.toBe(before)
    git('mv', 'src/app.ts', 'src/main.ts')
    const renamed = await fingerprint()
    expect(renamed).not.toBeNull()
    expect(renamed).not.toBe(deleted)
  })

  it('from a folder inside the repository, sees a new file anywhere in it', async () => {
    const inside = path.join(repo, 'src')
    const before = await fingerprint(inside)
    write('elsewhere/new.txt', 'new\n')
    expect(await fingerprint(inside)).not.toBe(before)
  })

  it('still answers with a git checkout of its own inside, or a link that points nowhere', async () => {
    const inner = path.join(repo, 'vendor', 'lib')
    fs.mkdirSync(inner, { recursive: true })
    execFileSync('git', ['-C', inner, 'init', '-q'])
    fs.symlinkSync(path.join(directory, 'gone'), path.join(repo, 'dangling'))
    const before = await fingerprint()
    expect(before).not.toBeNull()
    write('notes.txt', 'changed\n')
    expect(await fingerprint()).not.toBe(before)
  })

  it('answers for a repository with no commit yet, and changes as files appear', async () => {
    const fresh = path.join(directory, 'fresh')
    fs.mkdirSync(fresh)
    execFileSync('git', ['-C', fresh, 'init', '-q'])
    fs.writeFileSync(path.join(fresh, 'a.txt'), 'a\n')
    const before = await fingerprint(fresh)
    expect(before).not.toBeNull()
    fs.writeFileSync(path.join(fresh, 'a.txt'), 'b\n')
    expect(await fingerprint(fresh)).not.toBe(before)
  })

  it('changes when a file kept through a merge conflict is edited', async () => {
    git('add', '.')
    git('commit', '-q', '-m', 'all')
    git('checkout', '-q', '-b', 'gone')
    git('rm', '-q', 'README.md')
    git('commit', '-q', '-m', 'remove')
    git('checkout', '-q', 'main')
    write('README.md', 'changed here\n')
    git('commit', '-q', '-am', 'change')
    expect(() => git('merge', '-q', 'gone')).toThrow()
    const before = await fingerprint()
    write('README.md', 'resolved\n')
    expect(await fingerprint()).not.toBe(before)
  })

  it('answers nothing for a folder that is no git repository', async () => {
    const plain = path.join(directory, 'plain')
    fs.mkdirSync(plain)
    expect(await fingerprint(plain)).toBeNull()
  })
})
