// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import type { AccountView, CodexLimits, UsageSnapshot } from '../../src/shared/types'
import { CAP, FABLE_STOP, STALE_MS } from '../../src/shared/accountUsage'
import { ShapePill, shownGroups } from '../../src/renderer/src/components/usageFromShape'
import { usage as claudeUsage } from '../../src/agents/claude/renderer/usage'

const NOW_SEC = 1_700_000_000
const NOW_MS = NOW_SEC * 1000

afterEach(cleanup)

function snap(p: Partial<UsageSnapshot>): UsageSnapshot {
  return {
    u5: 0,
    u7: 0,
    uoi: 0,
    s5: '?',
    s7: '?',
    soi: '?',
    r5: 0,
    r7: 0,
    roi: 0,
    overage: '?',
    has5h: true,
    hasOi: true,
    at: NOW_MS,
    ...p
  }
}

function view(p: Partial<AccountView>): AccountView {
  return {
    name: 'a',
    kind: 'oauth',
    enabled: true,
    fable: 'unknown',
    status: 'ok',
    addedAt: 0,
    ...p
  }
}

interface DrawnBar {
  total: boolean
  stale: boolean
  fill: string | null
  height: string | null
  second: string | null
}

function pill(accounts: AccountView[]): DrawnBar[] {
  const { container } = render(<ShapePill groups={shownGroups(accounts, NOW_MS)} now={NOW_MS} />)
  return [...container.querySelectorAll('.tbu-bar')].map((bar) => {
    const fill = bar.querySelector<HTMLElement>('.tbu-fill')
    const second = bar.querySelector<HTMLElement>('.tbu-fable')
    return {
      total: bar.classList.contains('total'),
      stale: bar.classList.contains('stale'),
      fill: fill ? [...fill.classList].filter((c) => c !== 'tbu-fill').join(' ') : null,
      height: fill?.style.height ?? null,
      second: second?.style.height ?? null
    }
  })
}

const pct = (v: number): string => `${Math.round(v * 100)}%`
const totalOf = (accounts: AccountView[]): DrawnBar | undefined =>
  pill(accounts).find((b) => b.total)

// CODEX§15
describe('a Codex account in the pill', () => {
  const codex = (limits: Partial<CodexLimits>, p: Partial<AccountView> = {}): AccountView =>
    view({ kind: 'codex-home', limits: { windows: [], at: NOW_MS, ...limits }, ...p })
  const week = (used: number) => [{ minutes: 10080, used, resetsAt: 0 }]

  it('draws its fullest window, walls at a full window or when Codex says a limit was reached, and greys when signed out', () => {
    expect(
      pill([codex({ windows: [...week(0.2), { minutes: 300, used: 0.75, resetsAt: 0 }] })])
    ).toEqual([{ total: false, stale: false, fill: 'warn', height: '75%', second: null }])
    expect(pill([codex({ windows: week(1) })])[0]).toMatchObject({ fill: 'bad', height: '100%' })
    expect(pill([codex({ windows: week(0.3), reached: true })])[0]).toMatchObject({
      fill: 'bad',
      height: '100%'
    })
    expect(pill([view({ kind: 'codex-home' })])[0]).toMatchObject({ fill: null })
    expect(pill([codex({ windows: week(0.3) }, { status: 'expired' })])[0]).toMatchObject({
      fill: 'cold',
      height: '100%'
    })
  })
})

// CODEX§15
describe('the Codex pool in the pill', () => {
  const codex = (name: string, limits?: Partial<CodexLimits>): AccountView =>
    view({
      name,
      kind: 'codex-home',
      ...(limits && { limits: { windows: [], at: NOW_MS, ...limits } })
    })
  const win = (minutes: number, used: number) => ({ minutes, used, resetsAt: 0 })

  it('draws a pool bar only from two measured accounts on, and walls it only when every one is walled', () => {
    expect(totalOf([codex('a', { windows: [win(10080, 0.2)] }), codex('b')])).toBeUndefined()
    expect(
      totalOf([
        codex('a', { windows: [win(10080, 0.2)] }),
        codex('b', { windows: [win(10080, 1)] })
      ])
    ).toMatchObject({ height: '60%' })
    expect(
      totalOf([codex('a', { reached: true }), codex('b', { windows: [win(10080, 1)] })])
    ).toMatchObject({ fill: 'bad', height: '100%' })
  })
})

describe('the Claude pool in the pill', () => {
  const hardView = (name: string): AccountView =>
    view({ name, usage: snap({ s5: 'rejected', r5: NOW_SEC + 7_200, u5: 1 }) })

  it('under two measured accounts there is no pool to draw', () => {
    expect(totalOf([view({ usage: snap({ u5: 0.5 }) })])).toBeUndefined()
    expect(totalOf([view({ usage: snap({ u5: 0.5 }) }), view({ name: 'cold' })])).toBeUndefined()
  })
  it('two measured accounts → a bar at the mean tension', () => {
    expect(
      totalOf([view({ usage: snap({ u7: 0.25 }) }), view({ name: 'b', usage: snap({ u5: 0.75 }) })])
    ).toEqual({ total: true, stale: false, fill: '', height: '50%', second: null })
  })
  it('one walled member does not wall the pool — it just weighs 1 in the mean', () => {
    expect(totalOf([hardView('a'), view({ name: 'b', usage: snap({ u5: 0.5 }) })])).toMatchObject({
      fill: 'warn',
      height: '75%'
    })
  })
  it('every measured member hard-walled → the top rail', () => {
    expect(totalOf([hardView('a'), hardView('b')])).toEqual({
      total: true,
      stale: false,
      fill: 'bad',
      height: '100%',
      second: null
    })
  })
  it('a pool short of the wall never touches the top rail', () => {
    expect(
      totalOf([view({ usage: snap({ u5: 0.95 }) }), view({ name: 'b', usage: snap({ u5: 0.97 }) })])
    ).toMatchObject({ fill: 'bad', height: pct(CAP) })
  })
  it('fades on the oldest snapshot in M; exactly 15min is not yet stale', () => {
    const pair = (age: number): AccountView[] => [
      view({ usage: snap({ u5: 0.4, at: NOW_MS }) }),
      view({ name: 'b', usage: snap({ u5: 0.4, at: NOW_MS - age }) })
    ]
    expect(totalOf(pair(STALE_MS))).toMatchObject({ stale: false })
    expect(totalOf(pair(STALE_MS + 1))).toMatchObject({ stale: true })
  })
  it('a walled pool carries staleness too', () => {
    expect(
      totalOf([
        hardView('a'),
        view({
          name: 'b',
          usage: snap({ s5: 'rejected', r5: NOW_SEC + 7_200, u5: 1, at: NOW_MS - STALE_MS - 1 })
        })
      ])
    ).toMatchObject({ fill: 'bad', stale: true })
  })
  it('no fable data in the pool → no fable layer', () => {
    expect(
      totalOf([
        view({ usage: snap({ u5: 0.5, hasOi: false }) }),
        view({ name: 'b', usage: snap({ u5: 0.5, uoi: 0.9, hasOi: false }) })
      ])
    ).toMatchObject({ second: null })
  })
  it('a fable layer above the bar shows; every fable bucket exhausted → a spent layer up to the top', () => {
    expect(
      totalOf([
        view({ usage: snap({ u5: 0.2, uoi: 0.6 }) }),
        view({ name: 'b', usage: snap({ u5: 0.2, uoi: 0.8 }) })
      ])
    ).toMatchObject({ height: '20%', second: '70%' })
    expect(
      totalOf([
        view({ usage: snap({ u5: 0.5, uoi: 1 }) }),
        view({ name: 'b', usage: snap({ u5: 0.5, soi: 'rejected' }) })
      ])
    ).toMatchObject({ second: '100%' })
  })
})

// CC§7
describe('the fable bar of a Claude Code account', () => {
  const fableCloseness = (uoi: number, soi: string): string | undefined =>
    claudeUsage
      .account(view({ usage: snap({ uoi, soi }) }), NOW_MS)
      .bars.find((b) => b.label === 'fable')?.closeness

  it('paints a rejected fable bucket bad however low the number is', () => {
    expect(fableCloseness(0.12, 'rejected')).toBe('bad')
  })

  it('keeps the fable-only thresholds for a bucket still serving', () => {
    expect(fableCloseness(0.84, 'ok')).toBe('')
    expect(fableCloseness(0.85, 'ok')).toBe('warn')
    expect(fableCloseness(0.9, 'ok')).toBe('warn')
    expect(fableCloseness(FABLE_STOP, 'ok')).toBe('bad')
  })
})
