// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeAll, vi } from 'vitest'
import type { JSX } from 'react'
import {
  DEFAULT_SETTINGS,
  type BackendId,
  type WorkspacePullResult,
  type WorkspaceRows
} from '../../src/shared/types'
import { BACKEND_LABEL, SESSION_BACKENDS } from '../../src/shared/sessionBackend'

vi.mock('../../src/renderer/src/components/SessionBackendIcon', () => ({
  SessionBackendIcon: ({ backend }: { backend: BackendId }) => <i data-backend={backend} />
}))

const REACT_TASK_LAG_MS = 40
const realSetImmediate = globalThis.setImmediate
let reactTasksLag = false
Object.assign(globalThis, {
  setImmediate: (run: (...args: unknown[]) => void, ...args: unknown[]) =>
    reactTasksLag ? setTimeout(run, REACT_TASK_LAG_MS, ...args) : realSetImmediate(run, ...args)
})

const { render, cleanup, fireEvent, screen, waitFor, act } = await import('@testing-library/react')
const { useStore } = await import('../../src/renderer/src/store')
const { SessionLaunchButtons, useSessionLaunch } =
  await import('../../src/renderer/src/components/SessionLaunchButtons')
const { WorkspacePicker } = await import('../../src/renderer/src/components/WorkspacePicker')
const { WorktreeSessionDialog } =
  await import('../../src/renderer/src/components/WorktreeSessionDialog')
const { NewProjectDialog } = await import('../../src/renderer/src/components/NewProjectDialog')

let answerPull: (r: WorkspacePullResult) => void = () => {}
let answerCreate: (r: { ok: false; reason: string }) => void = () => {}
let creates = 0

beforeAll(() => {
  Object.assign(window, {
    api: {
      home: '/home',
      sessions: {
        backends: async () => SESSION_BACKENDS.map((id) => ({ id, available: true })),
        onToolsChanged: () => () => {}
      },
      workspace: {
        pull: () => new Promise<WorkspacePullResult>((resolve) => (answerPull = resolve)),
        createProject: () => {
          creates++
          return new Promise((resolve) => (answerCreate = resolve))
        },
        worktrees: async () => []
      },
      github: { openItems: async () => ({ state: 'failed' }) }
    }
  })
})

afterEach(() => {
  reactTasksLag = false
  cleanup()
  useStore.setState((s) => ({
    settings: {
      ...s.settings,
      sessionMethods: DEFAULT_SETTINGS.sessionMethods,
      gitAutoFetch: DEFAULT_SETTINGS.gitAutoFetch,
      newProjectFolders: DEFAULT_SETTINGS.newProjectFolders
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

const pullDialogs: [string, (started: BackendId[]) => JSX.Element, () => void][] = [
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
    () => {}
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
    () => {
      fireEvent.change(screen.getByRole('textbox'), { target: { value: 'feat' } })
    }
  ]
]

const dropFocusFromADisabledFieldAsChromiumDoes = (): void => {
  const at = document.activeElement
  if (!(at instanceof HTMLInputElement || at instanceof HTMLButtonElement) || !at.disabled) return
  at.disabled = false
  at.blur()
  at.disabled = true
}

describe('SessionLaunchButtons while a behind workspace pulls before a start', () => {
  it.each(pullDialogs)(
    '%s: Pulling… shows the icon of the agent picked from the arrow, and a failed pull leaves Enter on the default agent, even pressed while React’s effects still lag the screen',
    async (_name, dialog, prepare) => {
      useStore.setState((s) => ({ settings: { ...s.settings, gitAutoFetch: false } }))
      const started: BackendId[] = []
      render(dialog(started))
      prepare()
      const pickAgent = await waitFor(() => {
        const button = screen.getByRole<HTMLButtonElement>('button', { name: 'Pick an agent' })
        expect(button.disabled).toBe(false)
        return button
      })
      fireEvent.click(pickAgent)
      fireEvent.click(await screen.findByRole('option', { name: new RegExp(BACKEND_LABEL.codex) }))
      const lead = (): string | null | undefined =>
        document.querySelector('button[data-default] [data-backend]')?.getAttribute('data-backend')
      await screen.findAllByText(/Pulling origin\/main…/)
      expect(lead()).toBe('codex')
      dropFocusFromADisabledFieldAsChromiumDoes()

      reactTasksLag = true
      act(() => answerPull({ ok: false, reason: 'not a fast-forward' }))
      await screen.findAllByText(/Pull failed/)
      expect(lead()).toBe('claude')
      fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Enter' })
      await waitFor(() => expect(started).toEqual(['claude']))
    }
  )
})

describe('New Project after a start fails', () => {
  it('puts the cursor back in the folder field, so Enter tries again', async () => {
    useStore.setState((s) => ({
      settings: { ...s.settings, newProjectFolders: { local: '/projects' } }
    }))
    creates = 0
    render(
      <NewProjectDialog
        seed={{ prompt: '', title: '', machine: 'local', folder: 'demo', why: '' }}
        launchLock={{ current: false }}
        onClose={() => {}}
        onStart={async () => {}}
        onChangeWorkspace={() => {}}
      />
    )
    const folder = await screen.findByDisplayValue('demo')
    await waitFor(() => expect(document.activeElement).toBe(folder))
    await screen.findByRole('button', { name: 'Pick an agent' })
    fireEvent.keyDown(folder, { key: 'Enter' })
    await waitFor(() => expect(creates).toBe(1))
    dropFocusFromADisabledFieldAsChromiumDoes()

    reactTasksLag = true
    act(() => answerCreate({ ok: false, reason: 'The folder already exists.' }))
    await screen.findByText(/already exists/)
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Enter' })
    await waitFor(() => expect(creates).toBe(2))
  })
})
