import { beforeEach, describe, it, expect, vi } from 'vitest'
import type { SessionInfo } from '@shared/types'

const setState = vi.fn()
const osOpen = vi.fn()

vi.stubGlobal('window', {
  api: {
    workbench: { setState },
    preview: { osOpen },
    settings: { set: vi.fn() },
    terminal: { kill: vi.fn() }
  }
})

const { useStore } = await import('../../src/renderer/src/store')
const { activateTerminalLink } = await import('../../src/renderer/src/termLinks')

const SID = 'sess-1'
const TAB = 'pty-1'
const CLICK = {} as MouseEvent
const PANEL_ALREADY_READ_AT_MOUNT: Record<string, true> = { [TAB]: true }
const PANEL_COLLAPSED = { [TAB]: false }

beforeEach(() => {
  setState.mockClear()
  osOpen.mockClear()
  useStore.setState({
    tabs: [{ id: TAB, kind: 'claude', host: 'local', title: 'S', cwd: '/ws', alive: true }],
    activeTabId: TAB,
    sessions: [{ tabId: TAB, sessionId: SID, alive: true, title: 'S', cwd: '/ws' } as SessionInfo],
    workbench: {},
    workbenchFetched: PANEL_ALREADY_READ_AT_MOUNT,
    workbenchOpen: PANEL_COLLAPSED,
    workbenchLoad: null,
    toast: null
  })
})

describe('activateTerminalLink: a URL clicked in the terminal is a user open (§05B row 6 / F1)', () => {
  it('opens the clicked URL as a foreground `web` tab after the pinned files tab, expanding a collapsed panel (FR-57)', () => {
    activateTerminalLink(CLICK, 'http://localhost:5173/a')

    const set = useStore.getState().workbench[TAB]
    expect(set.tabs.map((t) => t.url)).toEqual([undefined, 'http://localhost:5173/a'])
    expect(set.activeId).toBe(set.tabs[1].id)
    expect(set.tabs[1].unread).toBe(false)
    expect(useStore.getState().workbenchOpen[TAB]).toBe(true)
    expect(useStore.getState().workbenchLoad?.tabId).toBe(set.tabs[1].id)
  })

  it('never hands the URL to the OS opener, the web-links addon default', () => {
    activateTerminalLink(CLICK, 'https://example.com/pr/1')

    expect(useStore.getState().workbench[TAB].tabs.map((t) => t.url)).toEqual([
      undefined,
      'https://example.com/pr/1'
    ])
    expect(osOpen).not.toHaveBeenCalled()
  })
})
