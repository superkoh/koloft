// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeAll, vi } from 'vitest'
import { render, cleanup, act, fireEvent } from '@testing-library/react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { WorkbenchPaneProps } from '../../src/renderer/src/components/WorkbenchPane'

const drawn: Record<string, number> = {}
const guests: Record<string, { onLoading(loading: boolean): void }> = {}

function counting(name: string) {
  return () => {
    drawn[name] = (drawn[name] ?? 0) + 1
    return null
  }
}

vi.mock('../../src/renderer/src/components/TerminalView', async (orig) => ({
  ...(await orig<object>()),
  TerminalView: counting('terminal')
}))
vi.mock('../../src/renderer/src/components/ArtifactPane', async (orig) => ({
  ...(await orig<object>()),
  ArtifactPane: counting('file tab')
}))
vi.mock('../../src/renderer/src/components/ChangesView', async (orig) => ({
  ...(await orig<object>()),
  ChangesView: counting('file list')
}))
vi.mock('../../src/renderer/src/components/BrowserGuest', async (orig) => ({
  ...(await orig<object>()),
  BrowserGuest: (props: {
    url: string
    onElement(el: unknown): void
    onLoading(loading: boolean): void
  }) => {
    drawn[`page ${props.url}`] = (drawn[`page ${props.url}`] ?? 0) + 1
    guests[props.url] = props
    useEffect(() => {
      props.onElement({
        getWebContentsId: () => props.url.length,
        getURL: () => props.url,
        canGoBack: () => false,
        canGoForward: () => false,
        isLoading: () => false,
        loadURL: () => Promise.resolve(),
        findInPage: () => 0,
        stopFindInPage: () => {},
        addEventListener: () => {},
        removeEventListener: () => {}
      })
    }, [])
    return null
  }
}))
const CHANGESET = {
  git: {},
  numstat: {},
  base: null,
  rootMissing: false,
  watchDead: false,
  firstReadFailed: false,
  reread: () => {}
}
vi.mock('../../src/renderer/src/components/gitChangeSet', async (orig) => ({
  ...(await orig<object>()),
  useGitChangeSet: () => CHANGESET,
  useWatchlessRefresh: () => {}
}))

function anyApi(): unknown {
  return new Proxy(function () {}, {
    get: (_t, k) =>
      k === 'then' ? undefined : k === 'browserGuestLimit' ? 6 : k === 'home' ? '/home' : anyApi(),
    apply: () =>
      Object.assign(() => {}, {
        then: (ok?: (v: unknown) => unknown, bad?: (e: unknown) => unknown) =>
          Promise.resolve(null).then(ok, bad)
      })
  })
}
;(window as unknown as { api: unknown }).api = anyApi()

const { useStore } = await import('../../src/renderer/src/store')
const { WorkbenchPane } = await import('../../src/renderer/src/components/WorkbenchPane')

beforeAll(() => {
  ;(globalThis as unknown as { CSS: unknown }).CSS = { highlights: new Map() }
  globalThis.ResizeObserver = class {
    observe(): void {}
    disconnect(): void {}
    unobserve(): void {}
  }
})

afterEach(cleanup)

const tab = (id: string, kind: string, more: object = {}) => ({
  id,
  kind,
  title: id,
  unread: false,
  ...more
})

const statesFor = (p: string) =>
  ({
    [`pty-${p}-a`]: {
      tabs: [
        tab('files', 'files'),
        tab(`${p}-w1`, 'web', { url: `http://${p}.test/one` }),
        tab(`${p}-w2`, 'web', { url: `http://${p}.test/two` }),
        tab(`${p}-f1`, 'file', { path: '/repo/a.md' }),
        tab(`${p}-t1`, 'terminal', { cwd: '/repo' })
      ],
      activeId: 'files',
      recency: []
    },
    [`pty-${p}-b`]: {
      tabs: [tab('files', 'files'), tab(`${p}-t2`, 'terminal', { cwd: '/repo' })],
      activeId: 'files',
      recency: []
    }
  }) as unknown as WorkbenchPaneProps['states']

let openFind: () => void = () => {}

function Panel({ p }: { p: string }) {
  const states = useRef(statesFor(p))
  const [shown, setShown] = useState(states.current)
  const [command, setCommand] = useState<WorkbenchPaneProps['command']>(null)
  openFind = () => setCommand({ id: 'find', nonce: 1 } as WorkbenchPaneProps['command'])
  const onUpdate = useCallback<WorkbenchPaneProps['onUpdate']>((id, update, after) => {
    const next = update(states.current[id])
    if (next !== states.current[id]) {
      states.current = { ...states.current, [id]: next }
      setShown(states.current)
    }
    after?.()
  }, [])
  const none = useCallback(() => {}, [])
  const fixed = useRef({ live: new Set([`pty-${p}-a`, `pty-${p}-b`]), pinned: {}, ops: [] }).current
  return (
    <WorkbenchPane
      tabId={`pty-${p}-a`}
      states={shown}
      liveTabs={fixed.live}
      visible
      full={false}
      command={command}
      dialog={null}
      onUpdate={onUpdate}
      onEvicted={none}
      onExternalOpen={none}
      onCertProceed={none}
      onDialogAnswer={none}
      onToggleFull={none}
      panelFocus={0}
      onEscapeFellThrough={none}
      onReturnFocus={none}
      treeRoot="/repo"
      activeTabId={`pty-${p}-a`}
      pinned={fixed.pinned}
      tabForSession={() => undefined}
      cdpOps={fixed.ops}
      onCdpDone={none}
      onCdpCreate={() => Promise.resolve(null)}
    />
  )
}

async function panelOnFirstPage(p: string): Promise<HTMLElement> {
  useStore.setState({
    sessions: [{ tabId: `pty-${p}-a`, sessionId: `s-${p}-a`, updatedAt: 1 } as never],
    tabs: [{ id: `pty-${p}-a`, kind: 'claude', title: 'a', alive: true } as never]
  })
  const { container } = render(<Panel p={p} />)
  for (const id of [`${p}-w2`, `${p}-f1`, `${p}-w1`]) {
    await act(async () => {
      fireEvent.mouseDown(container.querySelector(`[data-wb-tab-id="${id}"]`)!)
    })
  }
  return container
}

const tabBodies = (p: string): Record<string, number> => ({
  terminal: drawn.terminal ?? 0,
  'file tab': drawn['file tab'] ?? 0,
  'file list': drawn['file list'] ?? 0,
  'shown page': drawn[`page http://${p}.test/one`] ?? 0,
  'other page': drawn[`page http://${p}.test/two`] ?? 0
})

describe('WorkbenchPane: a busy tab bar or find bar redraws no tab body', () => {
  it('the shown page loading redraws no terminal, file tab, file list or web page', async () => {
    await panelOnFirstPage('wbload')
    const before = tabBodies('wbload')
    for (let i = 0; i < 5; i++) {
      await act(async () => guests['http://wbload.test/one'].onLoading(true))
      await act(async () => guests['http://wbload.test/one'].onLoading(false))
    }
    expect(tabBodies('wbload')).toEqual(before)
  })

  it('typing in the find bar redraws no terminal, file tab, file list or web page', async () => {
    const container = await panelOnFirstPage('wbfind')
    await act(async () => openFind())
    const input = container.querySelector('input.find-input')!
    const before = tabBodies('wbfind')
    for (const q of ['a', 'ab', 'abc']) {
      await act(async () => {
        fireEvent.change(input, { target: { value: q } })
      })
    }
    expect(tabBodies('wbfind')).toEqual(before)
  })
})
