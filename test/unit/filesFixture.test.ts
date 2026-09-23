import fs from 'fs'
import os from 'os'
import path from 'path'
import { execFileSync } from 'child_process'
import { afterAll, describe, expect, it } from 'vitest'
import {
  baselinePathsIn,
  LINE42_MARKER,
  seedBrowseTree,
  setupChangeFixture
} from '../e2e/helpers/filesFixture'

const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-files-fixture-')))
afterAll(() => fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 3 }))

function dir(name: string): string {
  const d = path.join(scratch, name)
  fs.mkdirSync(d, { recursive: true })
  return d
}

// PLATFORM§30
function gitStdoutEvenOnNonZeroExit(cwd: string, ...args: string[]): string {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
  } catch (e) {
    return (e as { stdout?: string }).stdout ?? ''
  }
}

describe('seedBrowseTree', () => {
  it('puts WB-B03’s content-search beacon on line 42 and nowhere else', () => {
    const p = seedBrowseTree(dir('browse'))
    const lines = fs.readFileSync(p.deepFile, 'utf8').split('\n')
    expect(lines[41]).toContain(LINE42_MARKER)
    const everywhere = execFileSync('grep', ['-rl', LINE42_MARKER, '.'], {
      cwd: path.dirname(p.deepFile).replace(/\/lib\/deep\/nested$/, ''),
      encoding: 'utf8'
    })
    expect(everywhere.trim().split('\n')).toHaveLength(1)
  })

  it('lays down both hiding mechanisms WB-B01 tells apart', () => {
    const p = seedBrowseTree(dir('hide'))
    expect(fs.readFileSync(p.gitignore, 'utf8')).toContain('secrets/')
    expect(fs.existsSync(p.heavyFile)).toBe(true)
    expect(fs.existsSync(p.ignoredFile)).toBe(true)
  })

  it('needs no git at all — WB-C13 pins a workspace that is not a repo', () => {
    const d = dir('nongit')
    const p = seedBrowseTree(d)
    expect(fs.existsSync(path.join(d, '.git'))).toBe(false)
    expect(fs.existsSync(p.html)).toBe(true)
  })

  it('baselinePathsIn names exactly what the writer wrote (the WB-C15 worktree re-base)', () => {
    const d = dir('rebase')
    seedBrowseTree(d)
    const real = fs.realpathSync(d)
    for (const [key, value] of Object.entries(baselinePathsIn(real))) {
      for (const abs of Array.isArray(value) ? value : [value]) {
        expect(fs.existsSync(abs), `${key}: ${abs}`).toBe(true)
      }
    }
  })
})

describe('setupChangeFixture', () => {
  it('lands clean, which IS WB-C12’s precondition', () => {
    const fx = setupChangeFixture(dir('clean'))
    expect(fx.isClean()).toBe(true)
    expect(fx.base()).toBe(fx.head())
  })

  it('ignores the harness’s own NOTES.md, so a session adds no phantom changed file', () => {
    const fx = setupChangeFixture(dir('notes'))
    fs.writeFileSync(path.join(fx.root, 'NOTES.md'), '# Session notes\n')
    expect(fx.isClean()).toBe(true)
    expect(
      gitStdoutEvenOnNonZeroExit(fx.root, 'ls-files', '--others', '--exclude-standard').trim()
    ).toBe('')
  })

  it('stays clean after a worktree is added — git does not self-ignore one (WB-C15/C12)', () => {
    const fx = setupChangeFixture(dir('worktree'))
    const wt = path.join(fx.root, '.claude', 'worktrees', 'x')
    fs.mkdirSync(path.dirname(wt), { recursive: true })
    fx.git('worktree', 'add', '-q', wt, '-b', 'worktree-x')
    expect(fx.isClean()).toBe(true)
    expect(fs.existsSync(path.join(wt, 'src', 'change-1.ts'))).toBe(true)
  })

  it('modifyTracked(n): n files, one hunk each, and ⤢ has room to widen (WB-C01/C03)', () => {
    const fx = setupChangeFixture(dir('modify'))
    const five = fx.modifyTracked(5)
    expect(five).toHaveLength(5)
    expect(
      gitStdoutEvenOnNonZeroExit(fx.root, 'diff', '--name-status', fx.base(), '--')
        .trim()
        .split('\n')
    ).toHaveLength(5)

    const compact = gitStdoutEvenOnNonZeroExit(fx.root, 'diff', fx.base(), '--', five[0])
    expect(compact.split('\n').filter((l) => l.startsWith('@@'))).toHaveLength(1)
    const full = gitStdoutEvenOnNonZeroExit(
      fx.root,
      'diff',
      '-U1000000000',
      fx.base(),
      '--',
      five[0]
    )
    expect(full.split('\n').length).toBeGreaterThan(compact.split('\n').length + 20)
  })

  it('refuses to hand out more files than the pool holds, instead of silently under-delivering', () => {
    const fx = setupChangeFixture(dir('pool'))
    expect(() => fx.modifyTracked(99)).toThrow(/only carries/)
  })

  it('featureBranch: merge-base sees the committed change, vs HEAD does not (WB-C04)', () => {
    const fx = setupChangeFixture(dir('branch'))
    fx.featureBranch()
    expect(
      gitStdoutEvenOnNonZeroExit(fx.root, 'diff', '--name-status', fx.base(), '--')
        .trim()
        .split('\n')
    ).toHaveLength(2)
    expect(
      gitStdoutEvenOnNonZeroExit(fx.root, 'diff', '--name-status', 'HEAD', '--').trim().split('\n')
    ).toHaveLength(1)
  })

  it('specialStates: the merge conflict is REAL — git’s index says unmerged (WB-C07)', () => {
    const fx = setupChangeFixture(dir('special'))
    const s = fx.specialStates()
    expect(fx.unmergedPaths()).toEqual([fx.rel(s.conflicted)])
    expect(gitStdoutEvenOnNonZeroExit(fx.root, 'status', '--porcelain')).toContain('UU ')
  })

  it('specialStates: rename PAIRS instead of reading as a whole-file add (WB-C07)', () => {
    const fx = setupChangeFixture(dir('rename'))
    const s = fx.specialStates()
    expect(gitStdoutEvenOnNonZeroExit(fx.root, 'diff', '--name-status', fx.base(), '--')).toMatch(
      /R\d+\s+src\/oldname\.ts\s+src\/newname\.ts/
    )
    const paired = gitStdoutEvenOnNonZeroExit(
      fx.root,
      'diff',
      fx.base(),
      '--',
      fx.rel(s.renamed.from),
      fx.rel(s.renamed.to)
    )
    expect(paired.split('\n').length).toBeLessThan(20)
  })

  it('specialStates: the binary change is binary, the deletion is a D (WB-C07)', () => {
    const fx = setupChangeFixture(dir('bindel'))
    const s = fx.specialStates()
    expect(
      gitStdoutEvenOnNonZeroExit(fx.root, 'diff', fx.base(), '--', fx.rel(s.binary))
    ).toContain('Binary files')
    expect(gitStdoutEvenOnNonZeroExit(fx.root, 'diff', '--name-status', fx.base(), '--')).toMatch(
      /^D\s+src\/legacy\.ts$/m
    )
  })

  it('untracked and binary carry no numstat, a tracked text edit does (WB-C08)', () => {
    const fx = setupChangeFixture(dir('nonums'))
    const fresh = fx.addUntracked()
    fx.changeBinary()
    const [edited] = fx.modifyTracked(1)
    expect(
      gitStdoutEvenOnNonZeroExit(fx.root, 'ls-files', '--others', '--exclude-standard').trim()
    ).toBe(fx.rel(fresh))
    const numstat = gitStdoutEvenOnNonZeroExit(fx.root, 'diff', fx.base(), '--numstat')
    expect(numstat).toContain(`-\t-\t${fx.rel(fx.paths.binary)}`)
    expect(numstat).toContain(fx.rel(edited))
    expect(numstat).not.toContain(fx.rel(fresh))
  })

  it('editTracked is repeatable — a second call is a real change, not a no-op (WB-C09)', () => {
    const fx = setupChangeFixture(dir('repeat'))
    const target = fx.paths.changeable[0]
    fx.editTracked(target)
    const once = fs.readFileSync(target, 'utf8')
    fx.editTracked(target)
    expect(fs.readFileSync(target, 'utf8')).not.toBe(once)
  })

  it('bigChange clears 5000 lines on the strictest count — additions alone (WB-C16)', () => {
    const fx = setupChangeFixture(dir('big'))
    const touched = fx.bigChange()
    expect(touched.length).toBeGreaterThan(1)
    const added = gitStdoutEvenOnNonZeroExit(fx.root, 'diff', fx.base(), '--')
      .split('\n')
      .filter((l) => l.startsWith('+') && !l.startsWith('+++')).length
    expect(added).toBeGreaterThan(5000)
  })

  it('overflowAggregateDiff really blows gitDiff’s 64 MiB maxBuffer (WB-C11)', () => {
    const fx = setupChangeFixture(dir('overflow'))
    fx.overflowAggregateDiff()
    let partial: string | null = null
    try {
      execFileSync('git', ['diff', fx.base(), '--'], {
        cwd: fx.root,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024
      })
    } catch (e) {
      partial = (e as { stdout?: string }).stdout ?? ''
    }
    expect(partial).not.toBeNull()
    expect((partial as string).length).toBeGreaterThan(60 * 1024 * 1024)
    expect(partial as string).toContain('diff --git')
  })

  it('mixedOwnershipSet leaves the agent’s two files for the SESSION to write (WB-C06)', () => {
    const fx = setupChangeFixture(dir('mixed'))
    const m = fx.mixedOwnershipSet()
    const ns = gitStdoutEvenOnNonZeroExit(fx.root, 'diff', '--name-status', fx.base(), '--')
    expect(ns).toContain(fx.rel(m.external))
    expect(ns).toContain(fx.rel(m.deleted))
    expect(ns).not.toContain(m.agentTsRel)
    expect(ns).not.toContain(m.agentMdRel)
  })
})
