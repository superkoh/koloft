// @vitest-environment jsdom
process.env.TZ = 'UTC'

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { render, cleanup, act, fireEvent } from '@testing-library/react'
import type { AccountView } from '../../src/shared/types'

vi.mock('../../src/renderer/src/components/settings/GitAccountsSection', () => ({
  GitAccountsSection: () => null
}))

const PINNED = './usage-drawn'

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
let pushAccounts: (next: AccountView[]) => void = () => {}
const accounts = {
  list: () => Promise.resolve(shown),
  onUpdate: (cb: (next: AccountView[]) => void) => {
    pushAccounts = cb
    return () => {}
  },
  probe: () => Promise.resolve(shown),
  heldSignInFailure: () => Promise.resolve(null),
  onSignInProgress: () => () => {},
  act: () => answerReset()
}
const rest = anyApi() as Record<string, unknown>
;(window as unknown as { api: unknown }).api = new Proxy(
  {},
  {
    get: (_t, k) =>
      k === 'accounts' ? accounts : k === 'usageFromShape' ? fromShape : rest[k as string]
  }
)

const { ACCOUNT_SETS, NOW } = await import('./helpers/usageMatrix')
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

function withTextPiecesMarked(el: Element | null): string {
  if (!el) return '(none)'
  const copy = el.cloneNode(true) as Element
  const walk = document.createTreeWalker(copy, NodeFilter.SHOW_TEXT)
  for (let n = walk.nextNode(); n; n = walk.nextNode()) n.textContent = `⟨${n.textContent}⟩`
  return copy.outerHTML.replaceAll('><', '>\n<')
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
  const out = open
    ? [
        '== the pill',
        withTextPiecesMarked(document.querySelector('button.tbu')),
        '== its panel',
        withTextPiecesMarked(document.querySelector('.tbu-pop'))
      ]
    : ['== no pill']
  cleanup()
  return out
}

const OUTCOMES = ['reset', 'nothingToReset', 'noCredit', 'alreadyRedeemed', 'failed']

function readAgainAfterTheReset(a: AccountView): AccountView {
  if (!a.limits) return a
  return {
    ...a,
    limits: {
      ...a.limits,
      reached: false,
      windows: a.limits.windows.map((w) => ({ ...w, used: 0 })),
      resets: { available: 0 }
    }
  }
}

function rowAt(index: number): Element | null {
  return document.querySelectorAll('.tbu-pop .tbu-row')[index] ?? null
}

async function resetFlow(
  set: AccountView[],
  shape: boolean,
  offered: number,
  outcome: string
): Promise<string[]> {
  await openTopBar(set, shape)
  let answer: (v: string) => void = () => {}
  answerReset = () => new Promise<string>((r) => (answer = r))
  const button = document.querySelectorAll('.tbu-pop button.acct-relogin')[offered]
  const index = [...document.querySelectorAll('.tbu-pop .tbu-row')].indexOf(
    button.closest('.tbu-row')!
  )
  const shots = [`== reset offered on row ${index}, answered ${outcome}`]
  fireEvent.click(button)
  shots.push('-- asked', withTextPiecesMarked(rowAt(index)))
  fireEvent.click(document.querySelector('.tbu-pop .acct-confirm button.danger')!)
  shots.push('-- using', withTextPiecesMarked(rowAt(index)))
  act(() => pushAccounts(set.map(readAgainAfterTheReset)))
  await settle()
  shots.push('-- read again while using', withTextPiecesMarked(rowAt(index)))
  answer(outcome)
  await settle()
  shots.push('-- answered', withTextPiecesMarked(rowAt(index)))
  cleanup()
  return shots
}

async function resetFlows(set: AccountView[], shape: boolean): Promise<string[]> {
  const offered = (await openTopBar(set, shape))
    ? document.querySelectorAll('.tbu-pop button.acct-relogin').length
    : 0
  cleanup()
  const shots: string[] = []
  for (let row = 0; row < offered; row++)
    for (const outcome of OUTCOMES) shots.push(...(await resetFlow(set, shape, row, outcome)))
  return shots
}

async function accountRows(set: AccountView[], shape: boolean): Promise<string[]> {
  shown = set
  fromShape = shape
  const { container } = render(<AccountsPane />)
  await settle()
  const rows = [...container.querySelectorAll('.acct-row')].map(withTextPiecesMarked)
  cleanup()
  return ['== account rows on the accounts page', ...rows]
}

async function drawn(set: AccountView[], shape: boolean): Promise<string> {
  return (
    [
      ...(await topBar(set, shape)),
      ...(await accountRows(set, shape)),
      ...(await resetFlows(set, shape))
    ].join('\n') + '\n'
  )
}

describe('usage drawn from each agent’s shape is the page pinned from the drawing it replaces', () => {
  for (const [name, set] of Object.entries(ACCOUNT_SETS)) {
    it(`top bar pill and panel, account rows, every answer to a saved reset: ${name}`, async () => {
      await expect(await drawn(set, false)).toMatchFileSnapshot(`${PINNED}/${name}.txt`)
      await expect(await drawn(set, true)).toMatchFileSnapshot(`${PINNED}/${name}.txt`)
    })
  }

  it('the sets reach every state the pinned pages are meant to cover', async () => {
    await openTopBar(ACCOUNT_SETS.everyAgent, false)
    const pop = document.querySelector('.tbu-pop')!.outerHTML
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
