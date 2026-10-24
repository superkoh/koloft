import { describe, expect, it } from 'vitest'
import type { SessionRow } from '@shared/types'
import { openSessionRow } from '../../src/renderer/src/sessionClick'
import { useStore } from '../../src/renderer/src/store'

function countResumePlans(): { plans: number } {
  const seen = { plans: 0 }
  ;(globalThis as { window?: unknown }).window = {
    api: {
      sessions: {
        resumePlan: async () => {
          seen.plans++
          return { action: 'unavailable', reason: 'not-found' }
        }
      }
    }
  }
  return seen
}

describe('clicking a session row', () => {
  it('a row that still reads cold while its session is already bound in a live tab goes to that tab and never starts a second resume', () => {
    const seen = countResumePlans()
    useStore.setState({
      tabs: [
        { id: 'pty-other', kind: 'claude', title: 'other', cwd: '/repo', alive: true },
        {
          id: 'pty-reattached',
          kind: 'claude',
          title: 'reattached',
          cwd: '/repo',
          sessionId: 'sid-reattached',
          alive: true
        }
      ],
      sessions: [{ tabId: 'pty-reattached', sessionId: 'sid-reattached', alive: true }] as never,
      activeTabId: 'pty-other'
    })
    const coldRow = { id: 'sid-reattached', running: false, title: 'reattached' } as SessionRow

    openSessionRow(coldRow, 'me@box:/repo')

    expect(useStore.getState().activeTabId).toBe('pty-reattached')
    expect(seen.plans).toBe(0)
  })

  it('a session record still naming a tab the window no longer has does not swallow the click: the row resumes', () => {
    const seen = countResumePlans()
    useStore.setState({
      tabs: [{ id: 'pty-other', kind: 'claude', title: 'other', cwd: '/repo', alive: true }],
      sessions: [{ tabId: 'pty-gone', sessionId: 'sid-stale', alive: true }] as never,
      activeTabId: 'pty-other'
    })
    const coldRow = { id: 'sid-stale', running: false, title: 'stale' } as SessionRow

    openSessionRow(coldRow, 'me@box:/repo')

    expect(seen.plans).toBe(1)
  })
})
