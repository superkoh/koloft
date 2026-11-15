// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup, act, fireEvent, screen } from '@testing-library/react'

vi.mock('../../src/renderer/src/components/settings/GitAccountsSection', () => ({
  GitAccountsSection: () => null
}))

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

const probes: ((v: unknown[]) => void)[] = []
const accounts = {
  list: () => Promise.resolve([]),
  onUpdate: () => () => {},
  probe: () => new Promise<unknown[]>((resolve) => probes.push(resolve)),
  signInFailure: () => Promise.resolve(null),
  onSignInFailure: () => () => {}
}
const rest = anyApi() as Record<string, unknown>
;(window as unknown as { api: unknown }).api = new Proxy(
  {},
  { get: (_t, k) => (k === 'accounts' ? accounts : rest[k as string]) }
)

const { AccountsPane } = await import('../../src/renderer/src/components/settings/AccountsPane')

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('Settings ▸ Accounts Refresh usage', () => {
  it('a second refresh started while the first one still reads “Updated” stays busy until its own read ends', async () => {
    vi.useFakeTimers()
    render(<AccountsPane />)
    const button = (): HTMLButtonElement =>
      screen.getByRole('button', { name: /Refresh usage|Refreshing|Updated/ })

    fireEvent.click(button())
    await act(async () => probes[0]([]))
    expect(button().textContent).toContain('Updated')

    await act(async () => vi.advanceTimersByTime(1000))
    fireEvent.click(button())
    expect(button().textContent).toContain('Refreshing')

    await act(async () => vi.advanceTimersByTime(2000))
    expect(button().textContent).toContain('Refreshing')
    expect(button().disabled).toBe(true)

    await act(async () => probes[1]([]))
    expect(button().textContent).toContain('Updated')
  })
})
