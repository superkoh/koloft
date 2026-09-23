import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { execFileSync } from 'child_process'
import { gitNumstat, sanitizeBase } from '../../src/main/gitStatus'

/**
 * The IPC boundary's `base` whitelist. `fs:gitStatus` / `fs:gitNumstat` / `fs:gitDiff` /
 * `fs:gitFileDiff(Full)` all forward a renderer-supplied `base` into `git diff <base> …`,
 * where it sits in an OPTION-PARSABLE slot: the `--` after it guards only pathspecs. So a
 * type check let `--output=<file>` through and git wrote the file — measured on all four
 * channels. index.ts's `baseArg` is a closure inside the handler registration and cannot be
 * imported, so the whitelist lives in gitStatus.ts as `sanitizeBase` and is pinned here.
 */

const SHA40 = '41bc8cd5b57f78e76e57ee127ce63d489203cccc'
const SHA64 = SHA40 + '0123456789abcdef01234567'

describe('sanitizeBase', () => {
  it('passes exactly what fs:diffBase can answer: the literal HEAD, or a hex object id', () => {
    expect(sanitizeBase('HEAD')).toBe('HEAD')
    expect(sanitizeBase(SHA40)).toBe(SHA40)
    expect(sanitizeBase(SHA64)).toBe(SHA64) // a sha256 repo's ids are 64 wide
    expect(sanitizeBase('4b82')).toBe('4b82') // the shortest abbreviation git accepts
  })

  it('drops an option — the measured `--output=<file>` write, and anything else dashed', () => {
    expect(sanitizeBase('--output=/tmp/pwned')).toBeUndefined()
    expect(sanitizeBase('--no-index')).toBeUndefined()
    expect(sanitizeBase('-U0')).toBeUndefined()
  })

  it('is a whitelist, not an option filter: every other rev spelling is dropped too', () => {
    const others = [
      'main',
      'origin/main',
      'HEAD~1',
      'HEAD^',
      'head',
      'ABCDEF',
      'abc',
      'HEAD\n',
      ' HEAD',
      `${SHA40}..HEAD`,
      ''
    ]
    for (const v of others) expect(sanitizeBase(v), JSON.stringify(v)).toBeUndefined()
  })

  it('drops non-strings, which is all the old check did', () => {
    for (const v of [undefined, null, 1, true, {}, ['HEAD']]) {
      expect(sanitizeBase(v)).toBeUndefined()
    }
  })
})

/** The attack itself, run against a real repo the way index.ts composes the call, so the
 *  case is falsifiable: the control shows git DOES write the file when the value reaches
 *  argv, and the guarded call shows the whitelist is what stops it. */
describe('sanitizeBase in front of a real git', () => {
  let tmp: string
  let repo: string

  beforeEach(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-gitbase-san-')))
    repo = path.join(tmp, 'work')
    execFileSync('git', ['init', '-q', '-b', 'main', repo], { stdio: 'ignore' })
    execFileSync('git', ['-C', repo, 'config', 'user.email', 't@t.com'], { stdio: 'ignore' })
    execFileSync('git', ['-C', repo, 'config', 'user.name', 't'], { stdio: 'ignore' })
    fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n')
    execFileSync('git', ['-C', repo, 'add', '-A'], { stdio: 'ignore' })
    execFileSync('git', ['-C', repo, 'commit', '-q', '-m', 'a'], { stdio: 'ignore' })
    fs.writeFileSync(path.join(repo, 'a.txt'), 'edited\n')
  })

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('a raw `--output=<file>` base writes the file (the control); the sanitized one does not', async () => {
    const target = path.join(tmp, 'written-by-git')
    await gitNumstat(repo, `--output=${target}`)
    expect(fs.existsSync(target)).toBe(true)
    fs.rmSync(target)

    const numstat = await gitNumstat(repo, sanitizeBase(`--output=${target}`))
    expect(fs.existsSync(target)).toBe(false)
    // …and the caller still gets a self-derived answer rather than nothing
    expect(numstat[path.join(repo, 'a.txt')]).toEqual({ added: 1, removed: 1 })
  })
})
