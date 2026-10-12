import { describe, it, expect } from 'vitest'
import { route, dockBadgeText, type RouteContext } from '../../src/main/notifyRouter'
import {
  DEFAULT_SETTINGS,
  type AttentionEvent,
  type AttentionKind,
  type Settings
} from '../../src/shared/types'

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
      expect(route(ev(kind), UNFOCUSED, settings()).os).toBe('banner')
    }
  })

  it('focused → NO outlet: the user is at the app, and the status dot is on screen', () => {
    for (const kind of KINDS) {
      expect(route(ev(kind), FOCUSED, settings())).toEqual({ os: 'none', sound: false })
    }
  })
})

describe('notifyRouter — D8 hard rule: a background test launch never hits an OS outlet', () => {
  it('never shows a banner; the one an unfocused window would get is recorded for the test instead', () => {
    for (const kind of KINDS) {
      expect(route(ev(kind), TEST_UNFOCUSED, settings())).toEqual({
        os: 'recordForTest',
        sound: false
      })
      expect(route(ev(kind), TEST_FOCUSED, settings())).toEqual({ os: 'none', sound: false })
    }
  })

  it('never beeps in test mode even for an approval with sound explicitly enabled', () => {
    for (const ctx of [TEST_FOCUSED, TEST_UNFOCUSED]) {
      const d = route(ev('approval'), ctx, settings({ notifyApprovalSound: true }))
      expect(d.sound).toBe(false)
    }
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
        expect(route(ev(kind), ctx, s)).toEqual({ os: 'none', sound: false })
      }
    })
  }

  it('disabling one category leaves the others notifying', () => {
    const s = settings({ notifyTurnDone: false })
    expect(route(ev('turn-done'), UNFOCUSED, s).os).toBe('none')
    expect(route(ev('approval'), UNFOCUSED, s).os).toBe('banner')
    expect(route(ev('exited'), UNFOCUSED, s).os).toBe('banner')
  })
})

describe('notifyRouter — sound is opt-in, approval-only, and focus-independent', () => {
  it('approval + sound enabled + not test → sound true whether focused or not', () => {
    const s = settings({ notifyApprovalSound: true })
    expect(route(ev('approval'), FOCUSED, s)).toEqual({ os: 'none', sound: true })
    expect(route(ev('approval'), UNFOCUSED, s)).toEqual({ os: 'banner', sound: true })
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

describe('dockBadgeText — the badge decision', () => {
  it('shows the pending count while enabled, actively clears at zero', () => {
    expect(dockBadgeText(2, true)).toBe('2')
    expect(dockBadgeText(0, true)).toBe('')
  })

  it('disabled actively clears (a stale count must not survive the toggle)', () => {
    expect(dockBadgeText(5, false)).toBe('')
  })
})
