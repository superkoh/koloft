import { describe, it, expect } from 'vitest'
import {
  browserOpenTargetSession,
  overlayPresentation
} from '../../src/renderer/src/browserOpenTarget'
import type { SessionInfo } from '../../src/shared/types'

function sess(over: Partial<SessionInfo>): SessionInfo {
  return {
    tabId: 't',
    sessionId: 's',
    title: 'x',
    cwd: '/w',
    rootDir: '/w',
    alive: true,
    ...over
  } as SessionInfo
}

describe('browserOpenTargetSession (D3/D6 fallback — review 2026-08-19)', () => {
  it('returns the session that owns the named tab (any source)', () => {
    const a = sess({ tabId: 't1', sessionId: 's1' })
    const b = sess({ tabId: 't2', sessionId: 's2' })
    expect(browserOpenTargetSession([a, b], { tabId: 't2', source: 'agent' })).toBe(b)
    expect(browserOpenTargetSession([a, b], { tabId: 't2', source: 'user' })).toBe(b)
  })

  it('user open over a non-session tab falls back to a LIVE session', () => {
    const dead = sess({ tabId: 't1', sessionId: 's1', alive: false })
    const live = sess({ tabId: 't2', sessionId: 's2', alive: true })
    // the request names t9 (no session) — pick the live one, not the dead one
    expect(browserOpenTargetSession([dead, live], { tabId: 't9', source: 'user' })).toBe(live)
  })

  it('user open with NO live session returns undefined (never a dead one — the bug fix)', () => {
    const dead1 = sess({ tabId: 't1', sessionId: 's1', alive: false })
    const dead2 = sess({ tabId: 't2', sessionId: 's2', alive: false })
    expect(
      browserOpenTargetSession([dead1, dead2], { tabId: 't9', source: 'user' })
    ).toBeUndefined()
  })

  // What is left for the fallback once R12 has had its say. A shell's own `open` no
  // longer arrives here unresolved: App maps the pty id to the conversation tab that owns
  // the shell (`conversationTabFor`) BEFORE calling this, so that request now matches a
  // bound tab on the first line and never reaches the fallback at all.
  //
  // The sources that still do reach it name no tab of any kind — an extension's
  // `chrome.tabs.create`, the Web Store button. The user is looking at whatever is on
  // screen, so that is where the page goes; falling back to the list's first live session
  // would open it in a session the user is not even looking at.
  it('user open with no bound tab prefers the ACTIVE tab’s session over the first live one', () => {
    const first = sess({ tabId: 't1', sessionId: 's1', alive: true })
    const onScreen = sess({ tabId: 't2', sessionId: 's2', alive: true })
    expect(
      browserOpenTargetSession([first, onScreen], { tabId: 'gt-1', source: 'user' }, 't2')
    ).toBe(onScreen)
  })

  it('…and falls back to any live session when the active tab has none', () => {
    const live = sess({ tabId: 't1', sessionId: 's1', alive: true })
    const shellTab = 't9' // a tab with no session of its own
    expect(browserOpenTargetSession([live], { tabId: 'gt-1', source: 'user' }, shellTab)).toBe(live)
  })

  it('never falls back to the active tab’s session when it is dead', () => {
    const deadActive = sess({ tabId: 't1', sessionId: 's1', alive: false })
    const live = sess({ tabId: 't2', sessionId: 's2', alive: true })
    expect(
      browserOpenTargetSession([deadActive, live], { tabId: 'gt-1', source: 'user' }, 't1')
    ).toBe(live)
  })

  it('agent open over a non-session tab gets no fallback', () => {
    const live = sess({ tabId: 't2', sessionId: 's2', alive: true })
    expect(browserOpenTargetSession([live], { tabId: 't9', source: 'agent' })).toBeUndefined()
  })

  it('a named tab lacking a sessionId is not "bound" — a user open still falls back', () => {
    const noSid = sess({ tabId: 't1', sessionId: '', alive: true })
    const live = sess({ tabId: 't2', sessionId: 's2', alive: true })
    expect(browserOpenTargetSession([noSid, live], { tabId: 't1', source: 'user' })).toBe(live)
    expect(
      browserOpenTargetSession([noSid, live], { tabId: 't1', source: 'agent' })
    ).toBeUndefined()
  })
})

/**
 * R1 — the presentation split. Unit-level because the input it reads is
 * NOT the routing `source` the payload carries: main labels everything a session tab
 * fires as an agent's (SEC-14), and a shell tab's `open` carries that same label while
 * being the user's own keystroke (BB-03). Getting that wrong is a one-word slip that
 * every e2e in the A1 block would blame on the overlay instead.
 */
describe('overlayPresentation (R1 — user-triggered pops up right away / not user-triggered lands in the background)', () => {
  const tabs = (...ids: string[]): { id: string }[] => ids.map((id) => ({ id }))

  it('BB-01/03: an open from a live NON-session tab (island, plain shell) shows at once', () => {
    const live = sess({ tabId: 't1', sessionId: 's1', alive: true })
    expect(overlayPresentation({ tabId: 'gt-1' }, tabs('t1', 'gt-1'), [live])).toBe('now')
  })

  // the one session tab that reaches this split at all: a row whose session has not
  // bound yet (a bound one lands in its own panel, and a dead one has no tab)
  it('a session tab’s request is an agent’s: background, never a surface popping open', () => {
    const unbound = sess({ tabId: 't1', sessionId: '', alive: true })
    expect(overlayPresentation({ tabId: 't1' }, tabs('t1'), [unbound])).toBe('background')
  })

  it('BB-06: the tab that fired it has closed — a late open lands in the background', () => {
    const live = sess({ tabId: 't1', sessionId: 's1', alive: true })
    expect(overlayPresentation({ tabId: 'gone-9' }, tabs('t1'), [live])).toBe('background')
  })
})
