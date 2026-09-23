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

/**
 * The `base?` parameter and the `{text, truncated}` return shape — the two API changes
 * made to the git layer (spec §API / Interface).
 *
 * Both exist for reasons that are invisible from inside a single call, so they are tested
 * against a REAL repository rather than a stub:
 *
 *  - `base` serves FR-39's "vs HEAD" switch AND NFR-02's reuse (one refresh resolves the
 *    base once and hands the sha to every consumer). The only way to see that it is
 *    honoured is to build a repo where the merge-base and HEAD answers DIFFER — a commit
 *    on the branch — and check that each handler follows the base it was given.
 *  - `truncated` exists because an overflow used to hand back a partial diff silently. A
 *    boolean nobody asserts is a boolean that quietly goes wrong.
 */

let tmp: string
let repo: string

/** A repo whose merge-base answer and HEAD answer are deliberately different:
 *  `committed.txt` is committed ON the branch (so it is in the merge-base diff but not in
 *  the HEAD diff), while `working.txt` is an uncommitted edit (in both). */
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

  // a feature branch with one committed change on top of main
  git('checkout', '-q', '-b', 'feature')
  fs.writeFileSync(path.join(repo, 'committed.txt'), 'committed on the branch\n')
  git('add', '-A')
  git('commit', '-q', '-m', 'branch work')

  // …plus an uncommitted edit in the working tree
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
    // it is main's tip — the point the branch forked from — and NOT the branch tip
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

// FR-39 — the switch is one parameter, not a second code path. The oracle is the
// committed-on-the-branch file: it belongs to the merge-base answer and not to the HEAD one.
describe('base? threading (FR-39, NFR-02)', () => {
  it('gitStatus: the default base lists branch work, `HEAD` does not', async () => {
    const viaDefault = await gitStatus(repo)
    const viaHead = await gitStatus(repo, 'HEAD')

    expect(Object.keys(viaDefault).map((p) => path.basename(p))).toContain('committed.txt')
    expect(Object.keys(viaHead).map((p) => path.basename(p))).not.toContain('committed.txt')
    // the uncommitted edit is in BOTH — it is what "vs HEAD" still means
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
    // …and against HEAD the same file is unchanged, so both answer empty. Had the full
    // variant kept deriving its own merge-base, it would disagree with the compact one
    // exactly while Changes sat on `vs HEAD`.
    expect((await gitFileDiff(file, 'HEAD')).text).toBe('')
    expect((await gitFileDiffFull(file, 'HEAD')).text).toBe('')
  })
})

/**
 * FR-41/FR-42 — an UNRESOLVED merge conflict, which `gitStatus` has to overlay onto the
 * base diff's answer with `git ls-files -u`.
 *
 * Measured, and the reason the overlay exists at all: `git diff --name-status <base>`
 * reports a conflicted file as plain `M`. The `U` code appears only in a bare
 * index-vs-worktree diff, in `--cached`, and in porcelain (`UU`) — so on the path this
 * function normally takes, `classifyDiff`'s `'U'` branch is unreachable and a live
 * conflict is indistinguishable from an ordinary edit.
 *
 * It gets a hermetic test rather than resting on the e2e case because the overlay
 * degrades SILENTLY: its `catch` falls back to the base diff's classification, so a
 * regression does not throw, it just quietly answers `'modified'` again — the exact
 * pre-fix behavior, which FR-41/FR-42 (a conflict takes a one-line summary and does not
 * expand) cannot survive.
 */
describe('unresolved merge conflicts (FR-41/FR-42)', () => {
  it('classifies an unmerged path as conflict, not as the base diff’s `modified`', async () => {
    const dir = path.join(tmp, 'conflicted')
    fs.mkdirSync(dir)
    const fx = setupChangeFixture(dir)
    const states = fx.specialStates()

    // the fixture's own guarantee first: git really does hold an unmerged index here, so a
    // failure below is the reader's and not a fixture that stopped producing the state
    expect(fx.unmergedPaths()).toEqual([fx.rel(states.conflicted)])

    // `'modified'` is what this answered before the overlay — asserting the exact string is
    // the whole point, since a truthiness check passed against the broken version too
    expect((await gitStatus(fx.root))[states.conflicted]).toBe('conflict')
  })

  it('still sees a conflict OUTSIDE the session root when that root is a subdirectory', async () => {
    const dir = path.join(tmp, 'conflicted-subdir')
    fs.mkdirSync(dir)
    const fx = setupChangeFixture(dir)
    const states = fx.specialStates()
    // `ls-files` lists only what sits under its cwd. Run with `-C <session root>` from a
    // subdirectory, the overlay never listed a conflict elsewhere in the repo, so the file
    // kept the base diff's `M` (and expanded, which FR-42 forbids for a conflict). The
    // untracked listing had the identical defect; both now run at the toplevel.
    const sub = path.join(fx.root, 'nested-session-root')
    fs.mkdirSync(sub)
    expect(states.conflicted.startsWith(sub)).toBe(false) // the conflict is outside it
    expect((await gitStatus(sub))[states.conflicted]).toBe('conflict')
  })

  it('leaves the other special states alone — the overlay runs last and must not overreach', async () => {
    const dir = path.join(tmp, 'conflicted-mixed')
    fs.mkdirSync(dir)
    const fx = setupChangeFixture(dir)
    const states = fx.specialStates()
    const status = await gitStatus(fx.root)

    // the overlay wins over the base diff by design, so the risk it introduces is breadth:
    // these three share the repo with the conflict and must keep their own classification
    expect(status[states.deleted]).toBe('deleted')
    expect(status[states.renamed.to]).toBe('renamed')
    expect(status[states.binary]).toBe('modified')
  })
})

// §Edge/maxBuffer — a truncated result must never be presented as complete. The flag is
// the whole mechanism, so it is asserted on both sides: false for an ordinary diff, and
// present in the shape at all.
describe('the {text, truncated} return shape', () => {
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

  it('an untracked file reads as whole-file additions, and is NOT flagged truncated', async () => {
    // `git diff --no-index` exits non-zero whenever content differs, so its diff arrives
    // on a rejected error's stdout — the one path where "there was an error" is the
    // NORMAL outcome and must not be mistaken for an overflow.
    const untracked = path.join(repo, 'fresh.txt')
    fs.writeFileSync(untracked, 'brand new\n')
    const out = await gitFileDiff(untracked)
    expect(out.text).toContain('brand new')
    expect(out.truncated).toBe(false)
  })
})

// ＋ ▸ Open file… can hand repo A's base sha to a file in repo B; the old answer
// was an empty diff dressed up as "no changes".
describe('a base from another repo', () => {
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
