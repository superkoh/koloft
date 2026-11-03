import { describe, it, expect, beforeEach } from 'vitest'
import type { SessionInfo } from '@shared/types'
import { DEFAULT_SETTINGS } from '@shared/types'
import { useStore } from '../../src/renderer/src/store'

let opened: number

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

beforeEach(() => {
  opened = 0
  ;(globalThis as { window?: unknown }).window = {
    api: {
      conductors: {
        open: () => {
          opened++
          return new Promise(() => {})
        }
      },
      workbench: { get: async () => ({ open: false, tabs: [] }), setState: () => {} },
      terminal: { kill: () => {} },
      tabs: { moved: () => {} }
    }
  }
  useStore.setState({
    tabs: [],
    sessions: [],
    activeTabId: null,
    butlerTab: null,
    openFiles: {},
    workbench: {},
    workbenchOpen: {},
    workbenchFetched: {},
    workspaceRows: [],
    settings: { ...DEFAULT_SETTINGS, assist: { on: true, backend: 'claude' } }
  })
})

describe('closing the watched session lands on the butler', () => {
  it('still lands on the butler when the session ended before its terminal exited', () => {
    const s = useStore.getState()
    s.addTab({ id: 'ended-first', kind: 'claude', title: 'Claude', cwd: '/w', alive: true })
    s.setSessions([session('ended-first')])
    s.setSessions([])
    expect(useStore.getState().tabs[0].kind).toBe('shell')

    useStore.getState().removeTab('ended-first')

    expect(opened).toBe(1)
  })

  it('stays put when the session never started', () => {
    const s = useStore.getState()
    s.addTab({ id: 'never-bound', kind: 'claude', title: 'Claude', cwd: '/w', alive: true })

    s.removeTab('never-bound')

    expect(opened).toBe(0)
  })
})
