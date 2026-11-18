import { describe, it, expect } from 'vitest'
import { AWAY_AFTER_MS, OwnerPresence, Presence } from '../../src/core/presence'

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

function owner(asleepSince: number | null, awayForTests?: boolean) {
  const t = { now: 1_000_000, macIdle: 0, woken: 0 }
  const presence = new OwnerPresence({
    now: () => t.now,
    macIdleSeconds: () => t.macIdle,
    asleepSince,
    wake: () => {
      t.woken++
      presence.asleepSinceIs(null)
    },
    awayForTests: () => awayForTests
  })
  return { t, presence }
}

describe('OwnerPresence — one answer to where the owner is: at the Mac, away, or asleep', () => {
  it('asleep wins over everything, and an asleep owner is never away, so nothing is sent to them for being away', () => {
    const { t, presence } = owner(5, true)
    t.now += AWAY_AFTER_MS
    expect(presence.where()).toBe('asleep')
    expect(presence.away()).toBe(false)
  })

  it('awake, a test’s word on whether the owner is away is taken before the hands on Koloft', () => {
    expect(owner(null, true).presence.where()).toBe('away')
    expect(owner(null, false).presence.where()).toBe('at-the-mac')
    const { t, presence } = owner(null)
    expect(presence.where()).toBe('at-the-mac')
    t.now += AWAY_AFTER_MS
    expect(presence.where()).toBe('away')
  })

  it('the owner writing wakes them only while asleep, and every listener hears the night start and end with when it started', () => {
    const { t, presence } = owner(null)
    const heard: [number | null, number | null][] = []
    presence.listenToSleep((since, sleptAt) => heard.push([since, sleptAt]))
    presence.ownerWrote()
    expect(t.woken).toBe(0)
    presence.asleepSinceIs(null)
    presence.asleepSinceIs(7)
    presence.ownerWrote()
    expect(t.woken).toBe(1)
    expect(heard).toEqual([
      [7, null],
      [null, 7]
    ])
  })
})
