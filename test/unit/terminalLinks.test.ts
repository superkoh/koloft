import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest'
import type { Terminal } from '@xterm/xterm'
import { formatRemoteKey } from '@shared/remoteKey'
import type { SessionInfo } from '@shared/types'

const setState = vi.fn()
const osOpen = vi.fn()
const fileExists = vi.fn((_file: string) => Promise.resolve(true))

vi.stubGlobal('window', {
  api: {
    workbench: { setState },
    preview: { osOpen },
    settings: { set: vi.fn() },
    terminal: { kill: vi.fn() },
    fs: { fileExists }
  }
})

const { useStore } = await import('../../src/renderer/src/store')
const { activateTerminalLink, fileLinkProvider } = await import('../../src/renderer/src/termLinks')

const SID = 'sess-1'
const TAB = 'pty-1'
const CLICK = {} as MouseEvent
const PANEL_ALREADY_READ_AT_MOUNT: Record<string, true> = { [TAB]: true }
const PANEL_COLLAPSED = { [TAB]: false }

beforeEach(() => {
  setState.mockClear()
  osOpen.mockClear()
  useStore.setState({
    tabs: [{ id: TAB, kind: 'claude', title: 'S', cwd: '/ws', alive: true }],
    activeTabId: TAB,
    sessions: [{ tabId: TAB, sessionId: SID, alive: true, title: 'S', cwd: '/ws' } as SessionInfo],
    workbench: {},
    workbenchFetched: PANEL_ALREADY_READ_AT_MOUNT,
    workbenchOpen: PANEL_COLLAPSED,
    workbenchLoad: {},
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
    expect(useStore.getState().workbenchLoad[TAB]?.tabId).toBe(set.tabs[1].id)
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

const COLS = 80
const REMOTE_REST_MS = 100

function terminalShowing(rows: string[]): Terminal {
  const lineOf = (text: string) => {
    const chars = [...text.padEnd(COLS)]
    const cell = { x: 0, getWidth: () => 1, getChars: () => chars[cell.x] }
    return {
      length: COLS,
      getCell: (x: number) => {
        cell.x = x
        return cell
      },
      translateToString: (trim?: boolean) => (trim ? text : text.padEnd(COLS))
    }
  }
  return {
    cols: COLS,
    buffer: {
      active: { getLine: (i: number) => (rows[i] === undefined ? undefined : lineOf(rows[i])) }
    }
  } as unknown as Terminal
}

describe('fileLinkProvider: when a hovered row is looked up', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    fileExists.mockClear()
  })
  afterEach(() => vi.useRealTimers())

  it('in a local tab, asks at once, with no rest on the row', async () => {
    const term = terminalShowing(['see src/local-at-once.ts:3'])
    fileLinkProvider(term, () => ({ tabId: 'pty-local', cwd: '/ws' })).provideLinks(1, () => {})
    await vi.advanceTimersByTimeAsync(0)
    expect(fileExists).toHaveBeenCalledWith('/ws/src/local-at-once.ts')
  })

  it('in a remote tab, asks only once the mouse has rested 100 ms on a row, and never asks a row it left sooner', async () => {
    const term = terminalShowing(['see src/remote-left.ts:3', 'see src/remote-rested.ts:4'])
    const provider = fileLinkProvider(term, () => ({
      tabId: 'pty-remote',
      cwd: formatRemoteKey('box', '/home/u/p')
    }))
    provider.provideLinks(1, () => {})
    await vi.advanceTimersByTimeAsync(REMOTE_REST_MS / 2)
    provider.provideLinks(2, () => {})
    await vi.advanceTimersByTimeAsync(REMOTE_REST_MS - 1)
    expect(fileExists).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(fileExists.mock.calls).toEqual([
      [formatRemoteKey('box', '/home/u/p/src/remote-rested.ts')]
    ])
  })
})
