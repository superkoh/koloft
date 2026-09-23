import { describe, it, expect } from 'vitest'
import { isTrustedByClaude } from '../../src/main/claudeTrust'

const doc =
  (projects: Record<string, unknown>): (() => unknown) =>
  () => ({ projects })

// CC§9
describe('isTrustedByClaude', () => {
  it('says yes for the folder itself', () => {
    const read = doc({ '/Users/me/repo': { hasTrustDialogAccepted: true } })
    expect(isTrustedByClaude(read, '/Users/me/repo')).toBe(true)
  })

  it('says yes when an ancestor was trusted', () => {
    const read = doc({ '/Users/me/repo': { hasTrustDialogAccepted: true } })
    expect(isTrustedByClaude(read, '/Users/me/repo/.claude/worktrees/job-260906-0900')).toBe(true)
  })

  it('says no for a folder nobody answered for, and for one answered with false', () => {
    const read = doc({
      '/Users/me/other': { hasTrustDialogAccepted: true },
      '/Users/me/repo': { hasTrustDialogAccepted: false }
    })
    expect(isTrustedByClaude(read, '/Users/me/repo')).toBe(false)
    expect(isTrustedByClaude(read, '/Users/me/fresh')).toBe(false)
  })

  it('says no when the file cannot be read', () => {
    const read = (): unknown => {
      throw new Error('ENOENT')
    }
    expect(isTrustedByClaude(read, '/Users/me/repo')).toBe(false)
    expect(isTrustedByClaude(() => null, '/Users/me/repo')).toBe(false)
  })
})
