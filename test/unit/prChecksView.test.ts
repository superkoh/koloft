import { describe, it, expect } from 'vitest'
import type { PrCheckBucket, PrChecks } from '@shared/types'
import { checksDot, checksLine } from '../../src/renderer/src/components/prChecksView'

function checks(...buckets: PrCheckBucket[]): PrChecks {
  return {
    state: 'ok',
    checks: buckets.map((bucket, i) => ({ name: `c${i}`, bucket, link: '', workflow: '' }))
  }
}

describe('the GitHub button dot and the Checks line', () => {
  it('goes red on any failure, amber while any check still runs, green once one passed, and draws nothing otherwise', () => {
    expect(checksDot(checks('pass', 'pending', 'fail'))).toBe('fail')
    expect(checksDot(checks('pass', 'pending', 'skipping'))).toBe('pending')
    expect(checksDot(checks('pass', 'skipping', 'cancel'))).toBe('pass')
    expect(checksDot(checks('skipping'))).toBeNull()
    expect(checksDot({ state: 'signed-out' })).toBeNull()
    expect(checksDot(null)).toBeNull()
  })

  it('counts every check the pull request has, skipped ones included', () => {
    expect(checksLine(checks('fail', 'pass', 'pass', 'skipping', 'pending'))).toBe(
      'Checks · 1 failing of 5'
    )
    expect(checksLine(checks('pending', 'pass'))).toBe('Checks · 1 running of 2')
    expect(checksLine(checks('pass', 'skipping'))).toBe('Checks · 1 passed of 2')
    expect(checksLine(checks())).toBe('Checks · none')
  })

  it('says what to do when gh cannot answer', () => {
    expect(checksLine({ state: 'no-gh' })).toBe('Checks · install gh')
    expect(checksLine({ state: 'signed-out' })).toBe('Checks · run gh auth login')
    expect(checksLine({ state: 'no-pr' })).toBeNull()
  })
})
