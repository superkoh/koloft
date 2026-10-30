// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeAll, vi } from 'vitest'
import { render, cleanup, act, fireEvent } from '@testing-library/react'
import type {
  BackendId,
  MachineState,
  SessionInfo,
  SessionRow,
  WorkspaceRows
} from '../../src/shared/types'

const drawn: Record<string, number> = {}

vi.mock('../../src/renderer/src/components/SessionBackendIcon', () => ({
  SessionBackendIcon: ({ backend }: { backend: BackendId }) => {
    drawn[backend] = (drawn[backend] ?? 0) + 1
    return null
  }
}))

vi.mock('../../src/renderer/src/components/ButlerRow', () => ({ ButlerRow: () => null }))

const { useStore } = await import('../../src/renderer/src/store')
const { WorkspaceSidebar } = await import('../../src/renderer/src/components/WorkspaceSidebar')

beforeAll(() => {
  globalThis.ResizeObserver = class {
    observe(): void {}
    disconnect(): void {}
    unobserve(): void {}
  }
})

afterEach(cleanup)

function row(id: string, backendId: BackendId, running: boolean): SessionRow {
  return {
    id,
    title: `title ${id}`,
    worktree: 'main',
    cwd: '/repo',
    running,
    invalidCwd: false,
    mtime: 0,
    backendId,
    host: 'local'
  }
}

const claudeOn = (status: SessionInfo['status']): SessionInfo =>
  ({
    tabId: 'pty-claude',
    sessionId: 'claude-row',
    title: 'title claude-row',
    cwd: '/repo',
    treeRoot: '/repo',
    alive: true,
    backendId: 'claude',
    host: 'local',
    status
  }) as SessionInfo

describe('WorkspaceSidebar (C2): a row redraws only when what it shows changes', () => {
  it('a Claude row turning from working to waiting redraws that row and leaves the Codex row beside it alone', () => {
    useStore.setState({
      workspaceRows: [
        {
          workspace: { path: '/repo', missing: false, isGit: false, hasHistory: false },
          rows: [row('claude-row', 'claude', true), row('codex-row', 'codex', false)]
        }
      ],
      sessions: [claudeOn('working')],
      tabs: [],
      attention: []
    })
    const { container } = render(
      <WorkspaceSidebar
        onNewSession={() => {}}
        namedMethods={null}
        soleMethod="claude"
        onNewWorktreeSession={() => {}}
        onRestoreSession={() => {}}
        onScheduledJobs={() => {}}
      />
    )
    const claudeRow = container.querySelector('[data-tab-id="pty-claude"]')!
    expect(claudeRow.classList.contains('st-working')).toBe(true)
    const before = { ...drawn }

    act(() => useStore.setState({ sessions: [claudeOn('waiting')] }))

    expect(claudeRow.classList.contains('st-waiting')).toBe(true)
    expect(drawn.claude).toBe(before.claude + 1)
    expect(drawn.codex).toBe(before.codex)
  })
})

const roomy: MachineState = {
  busy: false,
  pressure: 1,
  load1: 2,
  cores: 10,
  queued: [],
  held: {},
  background: [],
  memory: {},
  sharedVmBytes: 0
}

const workspace = (path: string, rows: SessionRow[]): WorkspaceRows => ({
  workspace: { path, missing: false, isGit: false, hasHistory: false },
  rows
})

function renderSidebar(): HTMLElement {
  return render(
    <WorkspaceSidebar
      onNewSession={() => {}}
      namedMethods={null}
      soleMethod="claude"
      onNewWorktreeSession={() => {}}
      onRestoreSession={() => {}}
      onScheduledJobs={() => {}}
    />
  ).container
}

function stubMachineApi(): { free: ReturnType<typeof vi.fn>; drop: ReturnType<typeof vi.fn> } {
  const machine = { free: vi.fn(async () => true), drop: vi.fn(async () => true) }
  Object.assign(window, { api: { machine } })
  return machine
}

const menuItems = (): (string | null)[] =>
  [...document.body.querySelectorAll('.menu .mi')].map((el) => el.textContent)

const clickMenuItem = (text: string): void => {
  const item = [...document.body.querySelectorAll('.menu .mi')].find(
    (el) => el.textContent === text
  )
  fireEvent.click(item!)
}

describe('WorkspaceSidebar (C2): sessions that wait for a busy machine', () => {
  it('a queued launch shows as a queued row in its own workspace, and its menu starts it now or closes it', () => {
    const api = stubMachineApi()
    useStore.setState({
      workspaceRows: [workspace('/repo', []), workspace('/other', [])],
      sessions: [],
      tabs: [],
      attention: [],
      machine: {
        ...roomy,
        busy: true,
        queued: [
          {
            tabId: 'pty-queued',
            kind: 'codex',
            cwd: '/repo',
            title: 'Nightly run',
            since: Date.now()
          }
        ]
      }
    })
    const container = renderSidebar()

    const queued = container.querySelector(
      '[data-ws-path="/repo"] .ws-tab.st-queued[data-tab-id="pty-queued"]'
    )!
    expect(queued.textContent).toContain('Nightly run')
    expect(container.querySelector('[data-ws-path="/other"] .st-queued')).toBeNull()
    expect(container.querySelector('[data-ws-path="/repo"] .ws-next')?.textContent).toContain(
      '1 held'
    )

    fireEvent.contextMenu(queued)
    expect(menuItems()).toEqual(['Start now', 'Close'])
    clickMenuItem('Start now')
    expect(api.free).toHaveBeenCalledWith('pty-queued')

    fireEvent.contextMenu(queued)
    clickMenuItem('Close')
    expect(api.drop).toHaveBeenCalledWith('pty-queued')
  })

  it('a background session held before a command shows "waiting", and its menu lets it stop waiting for the machine', () => {
    const api = stubMachineApi()
    useStore.setState({
      workspaceRows: [workspace('/repo', [row('claude-row', 'claude', true)])],
      sessions: [claudeOn('working')],
      tabs: [],
      attention: [],
      machine: {
        ...roomy,
        busy: true,
        background: ['pty-claude'],
        held: { 'pty-claude': { since: Date.now(), command: 'npm run test:e2e' } }
      }
    })
    const container = renderSidebar()

    const sessionRow = container.querySelector('[data-tab-id="pty-claude"]')!
    const badge = [...sessionRow.querySelectorAll('.ws-tab-parked')].find(
      (el) => el.textContent === 'waiting'
    )
    expect(badge?.getAttribute('title')).toContain('npm run test:e2e')
    expect(container.querySelector('[data-ws-path="/repo"] .ws-next')?.textContent).toContain(
      '1 held'
    )

    fireEvent.contextMenu(sessionRow)
    expect(menuItems()).toEqual([
      'Reveal in Finder',
      'Copy session ID',
      "Don't wait for the machine",
      'Keep running',
      'Close'
    ])
    clickMenuItem("Don't wait for the machine")
    expect(api.free).toHaveBeenCalledWith('pty-claude')
  })

  it("a live session's memory shows beside its branch only while the machine is busy", () => {
    useStore.setState({
      workspaceRows: [workspace('/repo', [row('claude-row', 'claude', true)])],
      sessions: [claudeOn('working')],
      tabs: [],
      attention: [],
      machine: { ...roomy, memory: { 'pty-claude': 1.1 * 2 ** 30 } }
    })
    const container = renderSidebar()
    const sub = (): string =>
      container.querySelector('[data-tab-id="pty-claude"] .ws-tab-sub')!.textContent ?? ''

    expect(sub()).not.toContain('GB')

    act(() =>
      useStore.setState({
        machine: { ...roomy, busy: true, memory: { 'pty-claude': 1.1 * 2 ** 30 } }
      })
    )

    expect(sub()).toContain('≈1.1 GB')
  })
})
