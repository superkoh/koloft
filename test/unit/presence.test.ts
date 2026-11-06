import { describe, it, expect } from 'vitest'
import { AWAY_AFTER_MS, Presence } from '../../src/main/presence'

const A_SECOND_LATER = 1000

function clock() {
  const t = { now: 1_000_000, macIdle: 600 }
  const presence = new Presence({ now: () => t.now, macIdleSeconds: () => t.macIdle })
  return { t, presence }
}

describe('Presence — the owner is at the Mac only while their own hands are on Koloft', () => {
  it('is away once Koloft goes untouched for five minutes, whatever else the Mac is doing', () => {
    const { t, presence } = clock()
    t.macIdle = 0
    expect(presence.away()).toBe(false)
    t.now += AWAY_AFTER_MS - 1
    expect(presence.away()).toBe(false)
    t.now += 1
    expect(presence.away()).toBe(true)
  })

  it('at launch counts from when the Mac was last used, so a launch on an idle Mac is already away', () => {
    const { presence } = clock()
    presence.macLastUsed()
    expect(presence.away()).toBe(true)
  })

  it('input in Koloft counts only when the Mac saw it too, so input a helper or a test driver injects leaves the owner away', () => {
    const { t, presence } = clock()
    t.now += AWAY_AFTER_MS
    t.macIdle = 300
    presence.handsOn()
    expect(presence.away()).toBe(true)
    t.now += A_SECOND_LATER
    t.macIdle = 0
    presence.handsOn()
    expect(presence.away()).toBe(false)
    expect(presence.lastHandsAt()).toBe(t.now)
  })

  it('a locked screen is away at once, until the owner next touches Koloft', () => {
    const { t, presence } = clock()
    t.macIdle = 0
    presence.handsOn()
    presence.screenLocked()
    expect(presence.away()).toBe(true)
    t.now += A_SECOND_LATER
    presence.handsOn()
    expect(presence.away()).toBe(false)
  })
})
