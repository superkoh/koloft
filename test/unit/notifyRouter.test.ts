import { describe, it, expect } from 'vitest'
import { route, dockBadgeText, type RouteContext } from '../../src/main/notifyRouter'
import {
  DEFAULT_SETTINGS,
  type AttentionEvent,
  type AttentionKind,
  type Settings
} from '../../src/shared/types'

// Requirement (the outlet matrix D4/D3/D8): a raised event reaches the user through
// an OS notification ONLY when they are away from the app —
//   window focused                     → nothing: the sidebar's status dot already says it
//   window unfocused / minimized       → OS notification
// A disabled category (D3) fires nothing. Sound is opt-in, approval-only, and does NOT
// depend on focus (it covers "at the app but not looking at the sidebar"). Under a
// background test launch (D8, hard rule) no OS-level outlet may ever be used, so nothing
// fires at all. Deriving these from the spec (not the code) is what would catch an OS
// notification stealing focus while the user is typing, a killed category still
// notifying, or a beep leaking into a test run.
//
// The focused case used to raise an in-window toast; that outlet was removed along with
// the rest of the in-app attention UI. `RouteDecision` no longer has a `toast` field —
// the compiler (typecheck:test) is what pins that.

const ev = (kind: AttentionKind): AttentionEvent => ({ tabId: 'tab-A', kind, at: 1 })
const settings = (o: Partial<Settings> = {}): Settings => ({ ...DEFAULT_SETTINGS, ...o })

const FOCUSED: RouteContext = { windowFocused: true, backgroundTest: false }
const UNFOCUSED: RouteContext = { windowFocused: false, backgroundTest: false }
const TEST_FOCUSED: RouteContext = { windowFocused: true, backgroundTest: true }
const TEST_UNFOCUSED: RouteContext = { windowFocused: false, backgroundTest: true }

const KINDS: AttentionKind[] = ['turn-done', 'approval', 'exited']

describe('notifyRouter — where the user is decides whether to interrupt at all', () => {
  it('unfocused / minimized → OS notification', () => {
    for (const kind of KINDS) {
      expect(route(ev(kind), UNFOCUSED, settings()).os).toBe(true)
    }
  })

  it('focused → NO outlet: the user is at the app, and the status dot is on screen', () => {
    for (const kind of KINDS) {
      expect(route(ev(kind), FOCUSED, settings())).toEqual({ os: false, sound: false })
    }
  })
})

describe('notifyRouter — D8 hard rule: a background test launch never hits an OS outlet', () => {
  it('routes every kind, focused OR unfocused, to nothing at all', () => {
    for (const kind of KINDS) {
      for (const ctx of [TEST_FOCUSED, TEST_UNFOCUSED]) {
        expect(route(ev(kind), ctx, settings())).toEqual({ os: false, sound: false })
      }
    }
  })

  it('never beeps in test mode even for an approval with sound explicitly enabled', () => {
    const d = route(ev('approval'), TEST_UNFOCUSED, settings({ notifyApprovalSound: true }))
    expect(d).toEqual({ os: false, sound: false })
  })
})

describe('notifyRouter — a disabled category (D3) emits through NO outlet', () => {
  const cases: Array<[AttentionKind, keyof Settings]> = [
    ['turn-done', 'notifyTurnDone'],
    ['approval', 'notifyApproval'],
    ['exited', 'notifyExited']
  ]
  for (const [kind, flag] of cases) {
    it(`${kind} off → no OS notification and no sound in any focus/test state`, () => {
      const s = settings({ [flag]: false })
      for (const ctx of [FOCUSED, UNFOCUSED, TEST_FOCUSED, TEST_UNFOCUSED]) {
        expect(route(ev(kind), ctx, s)).toEqual({ os: false, sound: false })
      }
    })
  }

  it('disabling one category leaves the others notifying', () => {
    const s = settings({ notifyTurnDone: false })
    expect(route(ev('turn-done'), UNFOCUSED, s).os).toBe(false)
    expect(route(ev('approval'), UNFOCUSED, s).os).toBe(true)
    expect(route(ev('exited'), UNFOCUSED, s).os).toBe(true)
  })
})

describe('notifyRouter — sound is opt-in, approval-only, and focus-independent', () => {
  it('approval + sound enabled + not test → sound true whether focused or not', () => {
    const s = settings({ notifyApprovalSound: true })
    // focused raises NO notification, but the beep still fires: the user may be at the
    // app with their eyes on the terminal rather than the sidebar
    expect(route(ev('approval'), FOCUSED, s)).toEqual({ os: false, sound: true })
    expect(route(ev('approval'), UNFOCUSED, s)).toEqual({ os: true, sound: true })
  })

  it('approval with sound OFF (the default) → no sound', () => {
    expect(route(ev('approval'), FOCUSED, settings()).sound).toBe(false)
    expect(route(ev('approval'), UNFOCUSED, settings()).sound).toBe(false)
  })

  it('turn-done / exited never beep, even with the approval-sound setting on', () => {
    const s = settings({ notifyApprovalSound: true })
    expect(route(ev('turn-done'), UNFOCUSED, s).sound).toBe(false)
    expect(route(ev('exited'), UNFOCUSED, s).sound).toBe(false)
  })
})

describe('dockBadgeText — the badge decision, incl. the D8 dock guard', () => {
  it('never touches the Dock under a background test launch (null = hands off)', () => {
    expect(dockBadgeText(3, true, true)).toBeNull()
    expect(dockBadgeText(0, false, true)).toBeNull()
  })

  it('shows the pending count while enabled, actively clears at zero', () => {
    expect(dockBadgeText(2, true, false)).toBe('2')
    expect(dockBadgeText(0, true, false)).toBe('')
  })

  it('disabled actively clears (a stale count must not survive the toggle)', () => {
    expect(dockBadgeText(5, false, false)).toBe('')
  })
})
