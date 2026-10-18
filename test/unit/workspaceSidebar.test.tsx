// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeAll, vi } from 'vitest'
import { render, cleanup, act } from '@testing-library/react'
import type { BackendId, SessionInfo, SessionRow } from '../../src/shared/types'

const drawn: Record<string, number> = {}

vi.mock('../../src/renderer/src/components/SessionBackendIcon', () => ({
  SessionBackendIcon: ({ backend }: { backend: BackendId }) => {
    drawn[backend] = (drawn[backend] ?? 0) + 1
    return null
  }
}))

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
