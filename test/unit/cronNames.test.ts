import { describe, expect, it } from 'vitest'
import { hasWordChar, isValidModelName, slugOf, worktreeBase } from '@shared/cronNames'
import { isValidWorktreeName } from '@shared/worktreeName'

describe('slugOf', () => {
  it('lowercases and turns every run of other characters into one dash', () => {
    expect(slugOf('Nightly Report')).toBe('nightly-report')
    expect(slugOf('Release   DMG!! (patch)')).toBe('release-dmg-patch')
    expect(slugOf('每日报告 report')).toBe('report')
  })

  it('strips dashes off both ends', () => {
    expect(slugOf('  hello  ')).toBe('hello')
    expect(slugOf('---a---')).toBe('a')
  })

  it('cuts to 48 characters and still leaves a name a branch can use', () => {
    const s = slugOf('a'.repeat(70))
    expect(s).toHaveLength(48)
    expect(isValidWorktreeName(worktreeBase({ name: 'a'.repeat(70) }, Date.now()))).toBe(true)
  })

  it('never answers with an empty string', () => {
    expect(slugOf('!!!')).toBe('job')
    expect(slugOf('')).toBe('job')
    expect(slugOf('---')).toBe('job')
  })
})

describe('hasWordChar', () => {
  it('is what refuses a name with no letter or digit', () => {
    expect(hasWordChar('!!!')).toBe(false)
    expect(hasWordChar('   ')).toBe(false)
    expect(hasWordChar('a')).toBe(true)
    expect(hasWordChar('报告 9')).toBe(true)
  })
})

describe('isValidModelName', () => {
  it('accepts only a plain token, because the model name is typed into a login shell', () => {
    for (const model of ['sonnet', 'claude-3.5:latest_x', '1abc', 'a'.repeat(81)]) {
      expect(isValidModelName(model), model).toBe(true)
    }
    for (const model of [
      '',
      ' ',
      'a b',
      'sonnet; rm -rf ~',
      '$(id)',
      '`id`',
      'a|b',
      '-sonnet',
      'a'.repeat(82)
    ]) {
      expect(isValidModelName(model), model).toBe(false)
    }
  })
})

describe('worktreeBase', () => {
  it('stamps the due time on the local wall clock', () => {
    const due = new Date(2026, 8, 2, 21, 0, 0, 0)
    expect(worktreeBase({ name: 'Nightly Report' }, due.getTime())).toBe(
      'nightly-report-260902-2100'
    )
  })

  it('pads every part to two digits', () => {
    const due = new Date(2026, 0, 5, 9, 7, 0, 0)
    expect(worktreeBase({ name: 'x' }, due.getTime())).toBe('x-260105-0907')
  })
})
