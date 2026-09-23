import { beforeEach, describe, it, expect, vi } from 'vitest'
import type { SessionInfo } from '@shared/types'

/**
 * §05B row 6 / F1: a URL the terminal printed is a user open — the web-links addon hands
 * the click to this handler instead of its own, which asks the OS for the URL. After the
 * Workbench merge that lands as a foreground `web` tab in the session's panel (FR-11/57),
 * the same route a terminal tab's own `open <url>` takes.
 */
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

beforeEach(() => {
  setState.mockClear()
  osOpen.mockClear()
  useStore.setState({
    tabs: [{ id: TAB, kind: 'claude', title: 'S', cwd: '/ws', alive: true }],
    activeTabId: TAB,
    sessions: [{ tabId: TAB, sessionId: SID, alive: true, title: 'S', cwd: '/ws' } as SessionInfo],
    workbench: {},
    // an on-screen bound session has had its panel document read at mount (App's
    // `ensureWorkbench`); without the marker every write below would park behind a read
    // this stub cannot answer
    workbenchFetched: { [TAB]: true },
    // T1, so the expansion below is a real transition
    workbenchOpen: { [TAB]: false },
    workbenchLoad: null,
    toast: null
  })
})

describe('activateTerminalLink (§05B row 6 / F1)', () => {
  it('opens the clicked URL as a foreground `web` tab on the session (FR-57)', () => {
    activateTerminalLink(CLICK, 'http://localhost:5173/a')

    const set = useStore.getState().workbench[TAB]
    // [files, the clicked url] — `files` is pinned to slot 0 (FR-02)
    expect(set.tabs.map((t) => t.url)).toEqual([undefined, 'http://localhost:5173/a'])
    expect(set.activeId).toBe(set.tabs[1].id)
    expect(set.tabs[1].unread).toBe(false)
    // a user open expands a collapsed panel and loads immediately (FR-57)
    expect(useStore.getState().workbenchOpen[TAB]).toBe(true)
    expect(useStore.getState().workbenchLoad?.tabId).toBe(set.tabs[1].id)
  })

  it('never hands the URL to the OS opener', () => {
    activateTerminalLink(CLICK, 'https://example.com/pr/1')

    // barrier: the click really was handled, so the negative below cannot pass vacuously
    expect(useStore.getState().workbench[TAB].tabs.map((t) => t.url)).toEqual([
      undefined,
      'https://example.com/pr/1'
    ])
    expect(osOpen).not.toHaveBeenCalled()
  })
})
