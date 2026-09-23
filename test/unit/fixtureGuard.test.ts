import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterAll, describe, expect, it } from 'vitest'
import { assertFixtureDir } from '../e2e/helpers/fixtureGuard'

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-guard-'))
afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }))

describe('assertFixtureDir: the reject branches, which the e2e suite never reaches', () => {
  it('throws on undefined — the incident: cwd would fall back to the real repo', () => {
    expect(() => assertFixtureDir('gitInit', undefined)).toThrow(/gitInit.*no dir/)
  })

  it('throws on empty string — same silent-fallback class', () => {
    expect(() => assertFixtureDir('gitCommitAll', '')).toThrow(/gitCommitAll.*no dir/)
  })

  it('throws on a real dir outside the temp area — a defined-but-wrong path', () => {
    expect(() => assertFixtureDir('gitInit', process.cwd())).toThrow(/gitInit/)
    expect(() => assertFixtureDir('gitInit', process.cwd())).toThrow(/outside/)
  })

  // PLATFORM§3
  it('accepts a dir under os.tmpdir() in its un-realpath’d (symlinked) form', () => {
    expect(() => assertFixtureDir('gitInit', scratch)).not.toThrow()
  })

  it('accepts the same dir in its realpath’d form', () => {
    expect(() => assertFixtureDir('gitInit', fs.realpathSync(scratch))).not.toThrow()
  })

  it('accepts a symlink inside tmp that resolves inside tmp', () => {
    const target = path.join(scratch, 'target')
    fs.mkdirSync(target)
    const link = path.join(scratch, 'link')
    fs.symlinkSync(target, link)
    expect(() => assertFixtureDir('gitInit', link)).not.toThrow()
  })

  it('throws on a symlink inside tmp that resolves OUTSIDE tmp', () => {
    const link = path.join(scratch, 'escape')
    fs.symlinkSync(process.cwd(), link)
    expect(() => assertFixtureDir('gitInit', link)).toThrow(/outside/)
  })

  it('throws on a dir that does not exist — loud, never silent', () => {
    expect(() => assertFixtureDir('gitInit', path.join(scratch, 'nope'))).toThrow()
  })
})
