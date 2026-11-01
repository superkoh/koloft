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

function Dialog({ pullFirst }: { pullFirst: boolean }) {
  const launch = useSessionLaunch('local', neverStarts, () => {})
  return (
    <SessionLaunchButtons
      choice={launch.choice()}
      open
      onOpen={() => {}}
      busy={launch.starting}
      disabled={launch.starting}
      label={() => (launch.starting ? 'Starting…' : 'Waiting')}
      onStart={(backend) =>
        pullFirst ? launch.holdFor(backend) : void launch.launch({ cwd: '/repo' }, backend)
      }
    />
  )
}

async function pickFromArrow(picked: BackendId, pullFirst: boolean): Promise<HTMLElement> {
  const other: BackendId = picked === 'claude' ? 'codex' : 'claude'
  useStore.setState((s) => ({
    settings: {
      ...s.settings,
      sessionMethods: { ...s.settings.sessionMethods, defaultBackend: other }
    }
  }))
  render(<Dialog pullFirst={pullFirst} />)
  fireEvent.click(await screen.findByRole('option', { name: new RegExp(BACKEND_LABEL[picked]) }))
  return screen.findByRole('button', { name: pullFirst ? /Waiting/ : /Starting…/ })
}

const iconOf = (button: HTMLElement): string | null | undefined =>
  button.querySelector('[data-backend]')?.getAttribute('data-backend')

describe('SessionLaunchButtons after an agent is picked from the arrow', () => {
  it.each(SESSION_BACKENDS)(
    'Starting… shows the icon of %s, the picked agent, not the default agent’s',
    async (picked) => {
      expect(iconOf(await pickFromArrow(picked, false))).toBe(picked)
    }
  )

  it('a pull held for the picked agent before the start shows that agent’s icon too', async () => {
    expect(iconOf(await pickFromArrow('codex', true))).toBe('codex')
  })
})
