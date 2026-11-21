import fs from 'fs'
import os from 'os'
import path from 'path'
import { execFileSync } from 'child_process'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { localGitOut } from '../../src/main/host/localHost'
import { folderFingerprint } from '../../src/core/folderFingerprint'

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

  it('answers nothing for a folder that is no git repository', async () => {
    const plain = path.join(directory, 'plain')
    fs.mkdirSync(plain)
    expect(await fingerprint(plain)).toBeNull()
  })
})
