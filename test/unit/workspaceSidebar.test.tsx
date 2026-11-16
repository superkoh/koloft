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
import type { LaunchMenu } from '../../src/shared/sessionBackend'

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

const claudeAlone: LaunchMenu = { listed: ['claude'], named: null, sole: 'claude' }
const onlyClaude = { local: claudeAlone, ssh: claudeAlone }

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
        launchable={onlyClaude}
        onNewWorktreeSession={() => {}}
        onRestoreSession={() => {}}
        onSessionDefaults={() => {}}
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

const roomy: MachineState = { critical: false, slowed: [], memory: {} }

const workspace = (path: string, rows: SessionRow[]): WorkspaceRows => ({
  workspace: { path, missing: false, isGit: false, hasHistory: false },
  rows
})

function renderSidebar(): HTMLElement {
  return render(
    <WorkspaceSidebar
      onNewSession={() => {}}
      launchable={onlyClaude}
      onNewWorktreeSession={() => {}}
      onRestoreSession={() => {}}
      onSessionDefaults={() => {}}
      onScheduledJobs={() => {}}
    />
  ).container
}

const slowedMark = (container: HTMLElement, tabId: string): Element | undefined =>
  [...container.querySelectorAll(`[data-tab-id="${tabId}"] .ws-tab-parked`)].find(
    (el) => el.textContent === 'slowed'
  )

describe('WorkspaceSidebar (C2): sessions whose tools give way while memory is critical', () => {
  it('a slowed session’s row carries a "slowed" mark that says why, and loses it once the session is lifted', () => {
    useStore.setState({
      workspaceRows: [workspace('/repo', [row('claude-row', 'claude', true)])],
      sessions: [claudeOn('working')],
      tabs: [],
      attention: [],
      machine: { critical: true, slowed: ['pty-claude'], memory: {} }
    })
    const container = renderSidebar()

    expect(slowedMark(container, 'pty-claude')?.getAttribute('title')).toContain(
      'Memory is critical'
    )

    act(() => useStore.setState({ machine: { critical: true, slowed: [], memory: {} } }))

    expect(slowedMark(container, 'pty-claude')).toBeUndefined()
  })

  it('clicking a live session’s row tells Koloft the owner wants that session at full speed', () => {
    const free = vi.fn(async () => true)
    Object.assign(window, { api: { ...window.api, machine: { free } } })
    useStore.setState({
      workspaceRows: [workspace('/repo', [row('claude-row', 'claude', true)])],
      sessions: [claudeOn('working')],
      tabs: [],
      attention: [],
      machine: roomy
    })
    const container = renderSidebar()

    fireEvent.click(container.querySelector('[data-tab-id="pty-claude"]')!)
    expect(free).toHaveBeenCalledWith('pty-claude')
  })

  it("a live session's memory shows beside its branch only while memory is critical", () => {
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
        machine: { ...roomy, critical: true, memory: { 'pty-claude': 1.1 * 2 ** 30 } }
      })
    )

    expect(sub()).toContain('≈1.1 GB')
  })
})
