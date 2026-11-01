// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeAll, vi } from 'vitest'
import type { JSX } from 'react'
import { render, cleanup, fireEvent, screen, waitFor, act } from '@testing-library/react'
import { DEFAULT_SETTINGS, type BackendId, type WorkspaceRows } from '../../src/shared/types'
import { BACKEND_LABEL, SESSION_BACKENDS } from '../../src/shared/sessionBackend'

vi.mock('../../src/renderer/src/components/SessionBackendIcon', () => ({
  SessionBackendIcon: ({ backend }: { backend: BackendId }) => <i data-backend={backend} />
}))

const { useStore } = await import('../../src/renderer/src/store')
const { SessionLaunchButtons, useSessionLaunch } =
  await import('../../src/renderer/src/components/SessionLaunchButtons')
const { WorkspacePicker } = await import('../../src/renderer/src/components/WorkspacePicker')
const { WorktreeSessionDialog } =
  await import('../../src/renderer/src/components/WorktreeSessionDialog')

type PullResult = { ok: true; summary: string } | { ok: false; reason: string }
let answerPull: (r: PullResult) => void = () => {}

beforeAll(() => {
  Object.assign(window, {
    api: {
      home: '/home',
      sessions: {
        backends: async () => SESSION_BACKENDS.map((id) => ({ id, available: true })),
        onToolsChanged: () => () => {}
      },
      workspace: {
        pull: () => new Promise<PullResult>((resolve) => (answerPull = resolve)),
        worktrees: async () => [],
        fetchFreshness: async () => null
      },
      github: { openItems: async () => ({ state: 'failed' }) }
    }
  })
})

afterEach(() => {
  cleanup()
  useStore.setState((s) => ({
    settings: {
      ...s.settings,
      sessionMethods: DEFAULT_SETTINGS.sessionMethods,
      gitAutoFetch: DEFAULT_SETTINGS.gitAutoFetch
    }
  }))
})

const neverStarts = (): Promise<void> => new Promise(() => {})

function Dialog() {
  const launch = useSessionLaunch('local', neverStarts, () => {})
  return (
    <SessionLaunchButtons
      choice={launch.choice()}
      open
      onOpen={() => {}}
      busy={launch.starting}
      disabled={launch.starting}
      label={() => (launch.starting ? 'Starting…' : 'Create')}
      onStart={(backend) => void launch.launch({ cwd: '/repo' }, backend)}
    />
  )
}

describe('SessionLaunchButtons while a session starts', () => {
  it.each(SESSION_BACKENDS)(
    'Starting… shows the icon of %s, picked from the arrow, not the default agent’s',
    async (picked) => {
      const other: BackendId = picked === 'claude' ? 'codex' : 'claude'
      useStore.setState((s) => ({
        settings: {
          ...s.settings,
          sessionMethods: { ...DEFAULT_SETTINGS.sessionMethods, defaultBackend: other }
        }
      }))
      render(<Dialog />)
      fireEvent.click(
        await screen.findByRole('option', { name: new RegExp(BACKEND_LABEL[picked]) })
      )
      const start = await screen.findByRole('button', { name: /Starting…/ })
      expect(start.querySelector('[data-backend]')?.getAttribute('data-backend')).toBe(picked)
    }
  )
})

const behind: WorkspaceRows = {
  workspace: {
    path: '/repo',
    missing: false,
    isGit: true,
    hasHistory: false,
    freshness: {
      state: 'ok',
      behind: 3,
      ahead: 0,
      branch: 'main',
      head: 'a'.repeat(40),
      defRef: 'origin/main',
      onDefault: true,
      dirty: false,
      linked: false,
      hasSubmodules: false,
      fetchedAt: Date.now(),
      lastAttemptAt: Date.now()
    }
  },
  rows: []
}

const pullDialogs: [string, (started: BackendId[]) => JSX.Element, () => HTMLElement][] = [
  [
    'C10 ⌘N picker',
    (started) => (
      <WorkspacePicker
        mode="main"
        rows={[behind]}
        lastWsPath={null}
        pinned={behind}
        onClose={() => {}}
        onConfirm={async (_ws, backend) => void started.push(backend)}
        launchLock={{ current: false }}
      />
    ),
    () => document.body
  ],
  [
    'C8 New Worktree Session',
    (started) => (
      <WorktreeSessionDialog
        ws={behind}
        launchLock={{ current: false }}
        onClose={() => {}}
        onStart={async (_opts, backend) => void started.push(backend)}
      />
    ),
    () => screen.getByRole('textbox')
  ]
]

describe('SessionLaunchButtons while a behind workspace pulls before a start', () => {
  it.each(pullDialogs)(
    '%s: Pulling… shows the icon of the agent picked from the arrow, and a failed pull leaves Enter on the default agent',
    async (_name, dialog, enterTarget) => {
      useStore.setState((s) => ({ settings: { ...s.settings, gitAutoFetch: false } }))
      const started: BackendId[] = []
      render(dialog(started))
      const input = screen.queryByRole('textbox')
      if (input) fireEvent.change(input, { target: { value: 'feat' } })
      fireEvent.click(await screen.findByRole('button', { name: 'Pick an agent' }))
      fireEvent.click(await screen.findByRole('option', { name: new RegExp(BACKEND_LABEL.codex) }))
      const lead = (): string | null | undefined =>
        document.querySelector('button[data-default] [data-backend]')?.getAttribute('data-backend')
      await screen.findAllByText(/Pulling origin\/main…/)
      expect(lead()).toBe('codex')

      act(() => answerPull({ ok: false, reason: 'not a fast-forward' }))
      await screen.findAllByText(/Pull failed/)
      expect(lead()).toBe('claude')
      fireEvent.keyDown(enterTarget(), { key: 'Enter' })
      await waitFor(() => expect(started).toEqual(['claude']))
    }
  )
})
