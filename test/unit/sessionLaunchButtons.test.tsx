// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeAll, vi } from 'vitest'
import { render, cleanup, fireEvent, screen } from '@testing-library/react'
import type { BackendId } from '../../src/shared/types'
import { BACKEND_LABEL, SESSION_BACKENDS } from '../../src/shared/sessionBackend'

vi.mock('../../src/renderer/src/components/SessionBackendIcon', () => ({
  SessionBackendIcon: ({ backend }: { backend: BackendId }) => <i data-backend={backend} />
}))

const { useStore } = await import('../../src/renderer/src/store')
const { SessionLaunchButtons, useSessionLaunch } =
  await import('../../src/renderer/src/components/SessionLaunchButtons')

beforeAll(() => {
  Object.assign(window, {
    api: {
      sessions: {
        backends: async () => SESSION_BACKENDS.map((id) => ({ id, available: true })),
        onToolsChanged: () => () => {}
      }
    }
  })
})

afterEach(cleanup)

const neverStarts = (): Promise<void> => new Promise(() => {})

function Dialog() {
  const launch = useSessionLaunch('local', neverStarts, () => {})
  return (
    <SessionLaunchButtons
      choice={launch.choice()}
      open={true}
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
          sessionMethods: { ...s.settings.sessionMethods, defaultBackend: other }
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
