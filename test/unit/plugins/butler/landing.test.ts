import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import type { SessionInfo } from '@shared/types'
import { landAfterClosingAWatchedSession, useStore } from '../../../../src/renderer/src/store'
import { butlerLanding } from '../../../../src/plugins/butler/renderer/landing'
import { useButler } from '../../../../src/plugins/butler/renderer/state'

function session(tabId: string): SessionInfo {
  return {
    tabId,
    backendId: 'claude',
    host: 'local',
    sessionId: 'sid-' + tabId,
    title: 'Live title',
    cwd: '/w',
    treeRoot: '/w',
    files: [],
    alive: true,
    updatedAt: 0
  }
}

describe('closing the session you watch lands on the butler, whichever of session end and terminal exit comes first', () => {
  let butlersOpened: number
  const { settings } = useStore.getState()
  afterEach(() => {
    useStore.setState({ settings })
    useButler.setState({ openedTab: null })
  })
  beforeEach(() => {
    landAfterClosingAWatchedSession(butlerLanding)
    butlersOpened = 0
    ;(globalThis as { window?: unknown }).window = {
      api: {
        butler: {
          open: () => {
            butlersOpened++
            return new Promise(() => {})
          }
        }
      }
    }
    useStore.setState({
      tabs: [],
      sessions: [],
      activeTabId: null,
      openFiles: {},
      accounts: null,
      settings: {
        ...useStore.getState().settings,
        skipPermissionsAgreed: true,
        accounts: [
          { name: 'a', kind: 'oauth', enabled: true, fable: 'unknown', status: 'ok', addedAt: 1 }
        ]
      }
    })
  })

  it('lands on the butler when the session ended before its terminal exited', () => {
    const s = useStore.getState()
    s.addTab({ id: 'end-first', kind: 'claude', title: 'S', cwd: '/w', alive: true })
    s.setSessions([session('end-first')])
    s.setSessions([])
    expect(useStore.getState().tabs[0].kind).toBe('shell')

    useStore.getState().removeTab('end-first')

    expect(butlersOpened).toBe(1)
  })

  it('does not start the butler again when the butler’s own session ended before its terminal exited', () => {
    const s = useStore.getState()
    s.addTab({ id: 'own-butler', kind: 'claude', title: 'Alfred', cwd: '/w', alive: true })
    s.setSessions([{ ...session('own-butler'), overseer: true }])
    s.setSessions([])

    useStore.getState().removeTab('own-butler')

    expect(butlersOpened).toBe(0)
  })

  it('stays put when a session that ended in a background tab is picked and closed later', () => {
    const s = useStore.getState()
    s.addTab({ id: 'bg-ended', kind: 'claude', title: 'S', cwd: '/w', alive: true })
    s.addTab({ id: 'bg-watched', kind: 'claude', title: 'S', cwd: '/w', alive: true })
    s.setSessions([session('bg-ended'), session('bg-watched')])
    s.setSessions([session('bg-watched')])
    s.setActive('bg-ended')

    useStore.getState().removeTab('bg-ended')

    expect(butlersOpened).toBe(0)
  })

  it('stays put when a plain terminal that once ran claude is closed', () => {
    const s = useStore.getState()
    s.addTab({ id: 'plain-term', kind: 'shell', title: 'Terminal', cwd: '/w', alive: true })
    s.setSessions([session('plain-term')])
    s.setSessions([])

    useStore.getState().removeTab('plain-term')

    expect(butlersOpened).toBe(0)
  })
})
