import { describe, it, expect } from 'vitest'
import { route, dockBadgeText } from '../../src/main/notifyRouter'
import {
  DEFAULT_SETTINGS,
  type AttentionEvent,
  type AttentionKind,
  type Settings
} from '../../src/shared/types'

const ev = (kind: AttentionKind): AttentionEvent => ({ tabId: 'tab-A', kind, at: 1 })
const settings = (o: Partial<Settings> = {}): Settings => ({ ...DEFAULT_SETTINGS, ...o })

const FOCUSED = true
const UNFOCUSED = false

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

describe('notifyRouter — a disabled category (D3) emits through NO outlet', () => {
  const cases: Array<[AttentionKind, keyof Settings]> = [
    ['turn-done', 'notifyTurnDone'],
    ['approval', 'notifyApproval'],
    ['exited', 'notifyExited']
  ]
  for (const [kind, flag] of cases) {
    it(`${kind} off → no OS notification and no sound, focused or not`, () => {
      const s = settings({ [flag]: false, notifyApprovalSound: true })
      for (const focused of [FOCUSED, UNFOCUSED]) {
        expect(route(ev(kind), focused, s)).toEqual({ os: false, sound: false })
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
  it('approval + sound enabled → sound true whether focused or not', () => {
    const s = settings({ notifyApprovalSound: true })
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

describe('dockBadgeText — the badge decision', () => {
  it('shows the pending count while enabled, actively clears at zero', () => {
    expect(dockBadgeText(2, true)).toBe('2')
    expect(dockBadgeText(0, true)).toBe('')
  })

  it('disabled actively clears (a stale count must not survive the toggle)', () => {
    expect(dockBadgeText(5, false)).toBe('')
  })
})
