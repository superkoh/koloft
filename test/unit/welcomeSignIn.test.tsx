// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup, act, fireEvent, screen } from '@testing-library/react'
import type { BackendId, SignInStart } from '../../src/shared/types'

vi.mock('../../src/renderer/src/components/settings/GitAccountsSection', () => ({
  GitAccountsSection: () => null
}))

const guess = vi.hoisted(() => ({ inATab: undefined as boolean | undefined }))
vi.mock('../../src/renderer/src/signInLook', async (original) => {
  const real = await original<typeof import('../../src/renderer/src/signInLook')>()
  return {
    ...real,
    signsInInATab: (agent: BackendId) => guess.inATab ?? real.signsInInATab(agent)
  }
})

function anyApi(): unknown {
  return new Proxy(function () {}, {
    get: (_t, k) => (k === 'then' ? undefined : anyApi()),
    apply: () =>
      Object.assign(() => {}, {
        then: (ok?: (v: unknown) => unknown, bad?: (e: unknown) => unknown) =>
          Promise.resolve(null).then(ok, bad)
      })
  })
}

const answers: ((r: SignInStart) => void)[] = []
const beginSignIn = vi.fn(() => new Promise<SignInStart>((resolve) => answers.push(resolve)))
const own: Record<string, unknown> = {
  sessions: {
    backends: () =>
      Promise.resolve(['claude', 'codex', 'agy'].map((id) => ({ id, available: true }))),
    onToolsChanged: () => () => {}
  },
  workspace: { discover: () => Promise.resolve([]) },
  accounts: {
    beginSignIn,
    signInFailure: () => Promise.resolve(null),
    onSignInFailure: () => () => {}
  },
  settings: { set: () => Promise.resolve() }
}
const rest = anyApi() as Record<string, unknown>
;(window as unknown as { api: unknown }).api = new Proxy(
  {},
  { get: (_t, k) => own[k as string] ?? rest[k as string] }
)

const { useStore } = await import('../../src/renderer/src/store')
const { Welcome } = await import('../../src/renderer/src/components/Welcome')
const { AGENT_UIS } = await import('../../src/agents/uis')
const { BACKEND_LABEL, BACKEND_PRODUCT } = await import('../../src/shared/sessionBackend')

afterEach(() => {
  cleanup()
  answers.length = 0
  beginSignIn.mockClear()
  guess.inATab = undefined
})

async function atStepThree(agent: BackendId, skipPermissions = false): Promise<void> {
  const s = useStore.getState()
  useStore.setState({
    accounts: [],
    accountLogin: null,
    signIn: null,
    tabs: [],
    workspaceRows: [
      {
        workspace: { path: '/w' },
        rows: [{ id: 'r1', title: 'Old work', backendId: agent, mtime: 1, cwd: '/w' }]
      }
    ] as unknown as typeof s.workspaceRows,
    settings: { ...s.settings, skipPermissions }
  })
  render(<Welcome onAddFolder={async () => true} onAddRemote={() => {}} onStart={() => {}} />)
  const go = (): HTMLElement => document.querySelector<HTMLElement>('[data-welcome-go]')!
  for (const step of ['2', '3']) {
    await act(async () => {})
    fireEvent.click(go())
    await act(async () => {})
    expect(document.querySelector('.wl')?.getAttribute('data-step')).toBe(step)
  }
  fireEvent.click(screen.getByRole('tab', { name: new RegExp(`^${BACKEND_PRODUCT[agent]}`) }))
}

const signInButton = (agent: BackendId): HTMLElement =>
  screen.getByRole('button', { name: new RegExp(`Sign in to ${BACKEND_LABEL[agent]}`) })

describe('welcome step 3: which look a sign-in takes follows the agent’s answer', () => {
  it('an agent guessed to sign in in a tab that answers it signs in in the background waits for the browser in place', async () => {
    await atStepThree('claude')
    guess.inATab = true
    fireEvent.click(signInButton('claude'))
    expect(useStore.getState().accountLogin).toBeNull()
    await act(async () =>
      answers[0]({
        ok: true,
        progress: { kind: 'oauth', name: 'Claude', again: false, phase: 'starting' }
      })
    )
    expect(useStore.getState().accountLogin?.progress?.phase).toBe('starting')
    expect(screen.getByRole('button', { name: /Waiting for your browser/ })).toBeTruthy()
    expect(useStore.getState().signIn).toBeNull()
  })

  it('an agent guessed to sign in in the background that answers with a tab drops the wait and opens that tab', async () => {
    await atStepThree('codex')
    guess.inATab = false
    fireEvent.click(signInButton('codex'))
    expect(useStore.getState().accountLogin?.progress?.phase).toBe('starting')
    await act(async () =>
      answers[0]({
        ok: true,
        progress: {
          kind: 'codex-home',
          name: 'Codex',
          again: false,
          phase: 'inATab',
          tab: { tabId: 't-sign-in', cwd: '/home' }
        }
      })
    )
    expect(useStore.getState().accountLogin).toBeNull()
    expect(useStore.getState().signIn?.tabId).toBe('t-sign-in')
    expect(useStore.getState().tabs.some((t) => t.id === 't-sign-in')).toBe(true)
  })

  it('each agent starts its sign-in with the account kind it signs in through a browser with', async () => {
    for (const [agent, kind] of [
      ['claude', 'oauth'],
      ['codex', 'codex-home'],
      ['agy', 'agy-home']
    ] as const) {
      await atStepThree(agent)
      fireEvent.click(signInButton(agent))
      expect(beginSignIn).toHaveBeenLastCalledWith(kind, BACKEND_LABEL[agent], false)
      cleanup()
    }
  })
})

describe('welcome last step: the words about asking are the picked agent’s own', () => {
  for (const agent of ['claude', 'codex', 'agy'] as const) {
    it(`for ${agent}, both while sessions ask and while they do not`, async () => {
      const words = AGENT_UIS.find((ui) => ui.id === agent)!.welcome.whatItsSessionsAsk
      for (const skip of [false, true]) {
        await atStepThree(agent, skip)
        fireEvent.click(screen.getByRole('button', { name: /I’ll sign in later/ }))
        await act(async () => {})
        const line = document.querySelector('.wl-perm')!.textContent
        expect(line).toContain(skip ? words.askInstead : words.asks)
        cleanup()
      }
    })
  }
})
