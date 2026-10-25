import { describe, it, expect } from 'vitest'
import { AWAY_AFTER_MS, Presence } from '../../src/main/presence'

function clock() {
  const t = { now: 1_000_000, macIdle: 600 }
  const presence = new Presence({ now: () => t.now, macIdleSeconds: () => t.macIdle })
  return { t, presence }
}

describe('Presence — the owner is at the Mac only while their own hands are on Koloft', () => {
  it('counts from launch, and is away once Koloft goes untouched for five minutes, whatever else the Mac is doing', () => {
    const { t, presence } = clock()
    t.macIdle = 0
    expect(presence.away()).toBe(false)
    t.now += AWAY_AFTER_MS - 1
    expect(presence.away()).toBe(false)
    t.now += 1
    expect(presence.away()).toBe(true)
  })

  it('input in Koloft’s own window is the owner’s, even with the Mac otherwise idle', () => {
    const { t, presence } = clock()
    t.now += AWAY_AFTER_MS
    presence.handsOnWindow()
    expect(presence.away()).toBe(false)
    expect(presence.lastHandsAt()).toBe(t.now)
  })

  it('input in a Workbench page counts only when the Mac saw it too, so a helper driving the page leaves the owner away', () => {
    const { t, presence } = clock()
    t.now += AWAY_AFTER_MS
    t.macIdle = 300
    presence.handsOnPage()
    expect(presence.away()).toBe(true)
    t.macIdle = 0
    presence.handsOnPage()
    expect(presence.away()).toBe(false)
  })

  it('a locked screen is away at once, until the owner next touches Koloft', () => {
    const { presence } = clock()
    presence.screenLocked()
    expect(presence.away()).toBe(true)
    presence.handsOnWindow()
    expect(presence.away()).toBe(false)
  })
})
