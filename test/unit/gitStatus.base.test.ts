import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { execFileSync } from 'child_process'
import {
  diffBase,
  gitDiff,
  gitFileDiff,
  gitFileDiffFull,
  gitNumstat,
  gitStatus
} from '../../src/main/gitStatus'
import { setupChangeFixture } from '../e2e/helpers/filesFixture'

let tmp: string
let repo: string

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-gitbase-')))
  repo = path.join(tmp, 'work')
  const git = (...args: string[]): void => {
    execFileSync('git', ['-C', repo, ...args], { stdio: 'ignore' })
  }
  execFileSync('git', ['init', '-q', '-b', 'main', repo], { stdio: 'ignore' })
  git('config', 'user.email', 't@t.com')
  git('config', 'user.name', 't')
  fs.writeFileSync(path.join(repo, 'base.txt'), 'base\n')
  git('add', '-A')
  git('commit', '-q', '-m', 'base')

  git('checkout', '-q', '-b', 'feature')
  fs.writeFileSync(path.join(repo, 'committed.txt'), 'committed on the branch\n')
  git('add', '-A')
  git('commit', '-q', '-m', 'branch work')

  fs.writeFileSync(path.join(repo, 'working.txt'), 'uncommitted\n')
  git('add', '-A')
})

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('fs.diffBase (the channel NFR-02 exists for)', () => {
  it('resolves the merge-base with the default branch, not HEAD', async () => {
    const base = await diffBase(repo)
    expect(base).toBeTruthy()
    const mainTip = execFileSync('git', ['-C', repo, 'rev-parse', 'main'], {
      encoding: 'utf8'
    }).trim()
    const head = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], {
      encoding: 'utf8'
    }).trim()
    expect(base).toBe(mainTip)
    expect(base).not.toBe(head)
  })

  it('answers null outside a repo, so a caller can tell "no base" from "no repo"', async () => {
    expect(await diffBase(tmp)).toBeNull()
  })
})

describe('base? threading (FR-39, NFR-02)', () => {
  it('gitStatus: the default base lists branch work, `HEAD` does not', async () => {
    const viaDefault = await gitStatus(repo)
    const viaHead = await gitStatus(repo, 'HEAD')

    expect(Object.keys(viaDefault).map((p) => path.basename(p))).toContain('committed.txt')
    expect(Object.keys(viaHead).map((p) => path.basename(p))).not.toContain('committed.txt')
    expect(Object.keys(viaHead).map((p) => path.basename(p))).toContain('working.txt')
  })

  it('gitStatus: an explicit sha is used as given rather than re-derived', async () => {
    const base = await diffBase(repo)
    expect(await gitStatus(repo, base!)).toEqual(await gitStatus(repo))
  })

  it('gitNumstat follows the same base', async () => {
    const viaDefault = await gitNumstat(repo)
    const viaHead = await gitNumstat(repo, 'HEAD')
    expect(Object.keys(viaDefault).map((p) => path.basename(p))).toContain('committed.txt')
    expect(Object.keys(viaHead).map((p) => path.basename(p))).not.toContain('committed.txt')
  })

  it('gitDiff follows the same base', async () => {
    expect((await gitDiff(repo)).text).toContain('committed.txt')
    expect((await gitDiff(repo, 'HEAD')).text).not.toContain('committed.txt')
  })

  it('gitFileDiff and gitFileDiffFull follow it too — FR-38’s ⤢ must widen THAT diff', async () => {
    const file = path.join(repo, 'committed.txt')
    expect((await gitFileDiff(file)).text).not.toBe('')
    expect((await gitFileDiffFull(file)).text).not.toBe('')
    expect((await gitFileDiff(file, 'HEAD')).text).toBe('')
    expect((await gitFileDiffFull(file, 'HEAD')).text).toBe('')
  })
})

// PLATFORM§30
describe('unresolved merge conflicts (FR-41/FR-42): the ls-files -u overlay, whose failure silently falls back to modified', () => {
  it('classifies an unmerged path as conflict, not as the base diff’s `modified`', async () => {
    const dir = path.join(tmp, 'conflicted')
    fs.mkdirSync(dir)
    const fx = setupChangeFixture(dir)
    const states = fx.specialStates()

    expect(fx.unmergedPaths()).toEqual([fx.rel(states.conflicted)])

    expect((await gitStatus(fx.root))[states.conflicted]).toBe('conflict')
  })

  // PLATFORM§30
  it('still sees a conflict OUTSIDE the session root when that root is a subdirectory', async () => {
    const dir = path.join(tmp, 'conflicted-subdir')
    fs.mkdirSync(dir)
    const fx = setupChangeFixture(dir)
    const states = fx.specialStates()
    const sub = path.join(fx.root, 'nested-session-root')
    fs.mkdirSync(sub)
    expect(states.conflicted.startsWith(sub)).toBe(false)
    expect((await gitStatus(sub))[states.conflicted]).toBe('conflict')
  })

  it('leaves the other special states alone — the overlay runs last and must not overreach', async () => {
    const dir = path.join(tmp, 'conflicted-mixed')
    fs.mkdirSync(dir)
    const fx = setupChangeFixture(dir)
    const states = fx.specialStates()
    const status = await gitStatus(fx.root)

    expect(status[states.deleted]).toBe('deleted')
    expect(status[states.renamed.to]).toBe('renamed')
    expect(status[states.binary]).toBe('modified')
  })
})

describe('the {text, truncated} return shape: a truncated result is never presented as complete', () => {
  it('reports truncated:false for a diff that fit', async () => {
    const whole = await gitDiff(repo)
    expect(whole.truncated).toBe(false)
    expect(typeof whole.text).toBe('string')

    const one = await gitFileDiff(path.join(repo, 'committed.txt'))
    expect(one.truncated).toBe(false)
  })

  it('still answers the shape outside a repo rather than throwing — and SAYS it is no repo', async () => {
    const out = await gitDiff(tmp)
    expect(out).toEqual({ text: '', truncated: false, notRepo: true, toplevel: null })
    expect(await gitFileDiff(path.join(tmp, 'nope.txt'))).toEqual({ text: '', truncated: false })
  })

  it('a fresh `git init` with no files is a repo with nothing to show, not a non-repo', async () => {
    const fresh = path.join(tmp, 'fresh')
    fs.mkdirSync(fresh)
    execFileSync('git', ['-C', fresh, 'init', '-q'])
    expect(await gitDiff(fresh)).toEqual({
      text: '',
      truncated: false,
      notRepo: false,
      toplevel: fresh
    })
  })

  // PLATFORM§30
  it('an untracked file reads as whole-file additions, and is NOT flagged truncated by the non-zero exit', async () => {
    const untracked = path.join(repo, 'fresh.txt')
    fs.writeFileSync(untracked, 'brand new\n')
    const out = await gitFileDiff(untracked)
    expect(out.text).toContain('brand new')
    expect(out.truncated).toBe(false)
  })
})

describe('a repo with no commits yet', () => {
  it('gives ONE whole-file hunk for a staged-then-edited file in the full diff, since staged and unstaged diffs joined make two and the one-hunk inline viewer would draw the file twice', async () => {
    const fresh = path.join(tmp, 'fresh')
    execFileSync('git', ['init', '-q', fresh], { stdio: 'ignore' })
    const file = path.join(fresh, 'notes.txt')
    fs.writeFileSync(file, 'one\ntwo\n')
    execFileSync('git', ['-C', fresh, 'add', 'notes.txt'], { stdio: 'ignore' })
    fs.writeFileSync(file, 'one\ntwo\nthree\n')

    const { text } = await gitFileDiffFull(file)
    expect(text.match(/^@@ /gm)).toHaveLength(1)
    expect(text.match(/^\+one$/gm)).toHaveLength(1)
    expect(text).toMatch(/^\+three$/m)
  })
})

describe('a base sha from another repo, handed to a file opened from this one', () => {
  it("falls back to the FILE repo's own base, so the change still shows", async () => {
    const other = path.join(tmp, 'other')
    execFileSync('git', ['init', '-q', '-b', 'main', other], { stdio: 'ignore' })
    execFileSync(
      'git',
      [
        '-C',
        other,
        '-c',
        'user.email=t@t.com',
        '-c',
        'user.name=t',
        'commit',
        '-q',
        '--allow-empty',
        '-m',
        'a'
      ],
      { stdio: 'ignore' }
    )
    const foreign = execFileSync('git', ['-C', other, 'rev-parse', 'HEAD'], {
      encoding: 'utf8'
    }).trim()

    const file = path.join(repo, 'base.txt')
    fs.writeFileSync(file, 'base\nedited in B\n')
    expect((await gitFileDiffFull(file, foreign)).text).toContain('+edited in B')
    expect((await gitFileDiff(file, foreign)).text).toContain('+edited in B')
  })
})
