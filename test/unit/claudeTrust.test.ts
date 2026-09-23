import { describe, it, expect } from 'vitest'
import { isTrustedByClaude } from '../../src/main/claudeTrust'

/** `~/.claude.json` is where claude writes down which folders it has been trusted with.
 *  A scheduled run in a folder that is missing from it stalls on claude's trust question
 *  and dies at the start deadline (docs/claude-code-contract.md §9), so this answer
 *  decides both the form's warning and the deadline's wording. */

const doc =
  (projects: Record<string, unknown>): (() => unknown) =>
  () => ({ projects })

describe('isTrustedByClaude', () => {
  it('says yes for the folder itself', () => {
    const read = doc({ '/Users/me/repo': { hasTrustDialogAccepted: true } })
    expect(isTrustedByClaude(read, '/Users/me/repo')).toBe(true)
  })

  // claude walks up from the folder, so a run worktree under a trusted repo asks nothing
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

  // a missing file and a half-written one both throw out of the reader; neither is a yes
  it('says no when the file cannot be read', () => {
    const read = (): unknown => {
      throw new Error('ENOENT')
    }
    expect(isTrustedByClaude(read, '/Users/me/repo')).toBe(false)
    expect(isTrustedByClaude(() => null, '/Users/me/repo')).toBe(false)
  })
})
