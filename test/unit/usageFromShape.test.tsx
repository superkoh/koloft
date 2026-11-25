// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { render, cleanup, act, fireEvent } from '@testing-library/react'
import type { AccountView } from '../../src/shared/types'
import { ACCOUNT_SETS, AGY_SETS, CODEX_SETS, NOW } from './helpers/usageMatrix'

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

let shown: AccountView[] = []
let fromShape = false
let answerReset: () => Promise<string> = () => Promise.resolve('reset')
const accounts = {
  list: () => Promise.resolve(shown),
  onUpdate: () => () => {},
  probe: () => Promise.resolve(shown),
  signInFailure: () => Promise.resolve(null),
  onSignInFailure: () => () => {},
  codexUseReset: () => answerReset()
}
const rest = anyApi() as Record<string, unknown>
;(window as unknown as { api: unknown }).api = new Proxy(
  {},
  {
    get: (_t, k) =>
      k === 'accounts' ? accounts : k === 'usageFromShape' ? fromShape : rest[k as string]
  }
)

const { AGENT_UIS } = await import('../../src/agents/uis')
const { TopbarUsage } = await import('../../src/renderer/src/components/TopbarUsage')
const { AccountsPane } = await import('../../src/renderer/src/components/settings/AccountsPane')

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

async function settle(): Promise<void> {
  for (let i = 0; i < 3; i++) await act(() => new Promise<void>((r) => setTimeout(r, 0)))
}

function html(selector: string): string {
  return document.querySelector(selector)?.outerHTML ?? ''
}

async function openTopBar(set: AccountView[], shape: boolean): Promise<boolean> {
  shown = set
  fromShape = shape
  render(<TopbarUsage />)
  await settle()
  const pill = document.querySelector('button.tbu')
  if (!pill) return false
  fireEvent.click(pill)
  await settle()
  return true
}

async function topBar(set: AccountView[], shape: boolean): Promise<string[]> {
  const open = await openTopBar(set, shape)
  const out = open ? [html('button.tbu'), html('.tbu-pop')] : []
  cleanup()
  return out
}

const OUTCOMES = ['reset', 'nothingToReset', 'noCredit', 'alreadyRedeemed', 'failed']

async function resetFlow(
  set: AccountView[],
  shape: boolean,
  row: number,
  outcome: string
): Promise<string[]> {
  await openTopBar(set, shape)
  let answer: (v: string) => void = () => {}
  answerReset = () => new Promise<string>((r) => (answer = r))
  const shots: string[] = []
  fireEvent.click(document.querySelectorAll('.tbu-pop button.acct-relogin')[row])
  shots.push(html('.tbu-pop'))
  fireEvent.click(document.querySelector('.tbu-pop .acct-confirm button.danger')!)
  shots.push(html('.tbu-pop'))
  answer(outcome)
  await settle()
  shots.push(html('.tbu-pop'))
  cleanup()
  return shots
}

async function pane(set: AccountView[], shape: boolean): Promise<string> {
  shown = set
  fromShape = shape
  const { container } = render(<AccountsPane />)
  await settle()
  const out = container.innerHTML
  cleanup()
  return out
}

describe('usage drawn from each agent’s shape is the same page as the drawing it replaces', () => {
  for (const [name, set] of Object.entries(ACCOUNT_SETS)) {
    it(`top bar pill and panel: ${name}`, async () => {
      const before = await topBar(set, false)
      expect(await topBar(set, true)).toEqual(before)
    })

    it(`accounts page rows: ${name}`, async () => {
      const before = await pane(set, false)
      expect(await pane(set, true)).toBe(before)
    })
  }

  for (const [name, set] of Object.entries(ACCOUNT_SETS)) {
    it(`every answer to a saved reset, asked, running and answered: ${name}`, async () => {
      const offered = (await openTopBar(set, false))
        ? document.querySelectorAll('.tbu-pop button.acct-relogin').length
        : 0
      cleanup()
      for (let row = 0; row < offered; row++)
        for (const outcome of OUTCOMES) {
          const before = await resetFlow(set, false, row, outcome)
          expect(await resetFlow(set, true, row, outcome)).toEqual(before)
        }
    })
  }

  describe('what a shape shows today that is not yet its agent’s fact', () => {
    const usageUi = (id: string) => AGENT_UIS.find((ui) => ui.id === id)!.usage
    const codexByok = CODEX_SETS.codexEveryState.find((a) => a.name === 'byok')!

    it('#2629: Codex lights no fallback bar though every sign-in is walled and a key stands by', () => {
      const set = [...CODEX_SETS.codexAllWalled, codexByok]
      expect(usageUi('codex').group(set, NOW).fallbackBarLit).toBe(false)
    })

    it('#2630: an Antigravity account shows no age though its reading has a time', () => {
      const google = AGY_SETS.agyOne[0]
      expect(google.quotaAt).toBe(NOW)
      expect(usageUi('agy').account(google, NOW).ageShownFrom).toBeNull()
    })

    it('#2631: the top bar leaves out an Antigravity sign-in with no reading', () => {
      const rows = usageUi('agy')
        .group(AGY_SETS.agyEveryState, NOW)
        .rows.map((a) => a.name)
      expect(rows).not.toContain('new')
      expect(rows).not.toContain('logged-off')
    })

    it('#2632: Codex shows no failure beside old bars after a failed probe', () => {
      const flaky = CODEX_SETS.codexEveryState.find((a) => a.name === 'flaky')!
      expect(usageUi('codex').account(flaky, NOW).failureBesideBars).toBeNull()
    })

    it('#2633: Claude Code’s pill bars sit loose, the other agents’ in a group', () => {
      expect(AGENT_UIS.map((ui) => [ui.id, ui.usage.group([], NOW).pillBarsGrouped])).toEqual([
        ['claude', false],
        ['codex', true],
        ['agy', true]
      ])
    })
  })

  it('the sets reach every state the comparison is meant to cover', async () => {
    await openTopBar(ACCOUNT_SETS.everyAgent, false)
    const pop = html('.tbu-pop')
    for (const seen of [
      'no 5-hour limit',
      ' soon"',
      'reset due',
      'no reset time',
      'allowance spent',
      'cached 20m',
      'Use a reset',
      'Probe failed: model unavailable',
      'Gemini Models · 7d resets'
    ])
      expect(pop).toContain(seen)
    cleanup()
    expect((await topBar(ACCOUNT_SETS.claudeFallback, false)).join('')).toContain(
      'metered fallback active'
    )
  })
})
