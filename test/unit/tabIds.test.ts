import { describe, expect, it } from 'vitest'
import { TAB_IDS_KEPT_PER_TAB, carriedTabIds, tabIdList } from '../../src/main/tabIds'

describe('the tab ids a tab has run under', () => {
  it('still hold the id its agent was started under after more Koloft restarts than the list keeps, so a remote agent kept running in tmux all along is still reached under it', () => {
    let saved = tabIdList('pty-started', [])
    for (let restart = 1; restart <= TAB_IDS_KEPT_PER_TAB * 2; restart++) {
      const reopened = `pty-restart-${restart}`
      saved = tabIdList(reopened, carriedTabIds(reopened, [], saved))
    }
    expect(saved).toHaveLength(TAB_IDS_KEPT_PER_TAB)
    expect(saved[0]).toBe(`pty-restart-${TAB_IDS_KEPT_PER_TAB * 2}`)
    expect(saved).toContain('pty-started')
  })

  it('keep the id its agent was started under when a tab that already carries the ids it ran under is given a newer one as well', () => {
    const ranUnder = ['pty-before-6', 'pty-before-5', 'pty-before-4', 'pty-before-3']
    const carried = carriedTabIds('pty-now', [...ranUnder, 'pty-before-2', 'pty-started'], [])
    const both = carriedTabIds('pty-now', carried, ['pty-placeholder', 'pty-placeholder-earlier'])
    expect(both).toHaveLength(TAB_IDS_KEPT_PER_TAB - 1)
    expect(both[0]).toBe('pty-placeholder')
    expect(both.at(-1)).toBe('pty-started')
  })
})
