import { describe, it, expect } from 'vitest'
import { makeDropDedupe, ownsHookReport } from '../../src/main/hookRouting'

const PARENT = 'f2954c58-a979-4e3f-92f3-e6aed7806bcb'
const FORK = 'f68fbf6d-b57c-48b5-b2ca-325ce86ddac0'

// CC§5
describe('ownsHookReport: a hook report acts on a tab only when it belongs to the session that tab drives', () => {
  // CC§1
  describe('SessionStart', () => {
    it('rejects a fork — the copy is a background session, not this tab', () => {
      expect(ownsHookReport({ event: 'start', source: 'fork', sessionId: FORK }, PARENT)).toBe(
        false
      )
    })

    it('rejects a fork even when the report carries no session id', () => {
      expect(ownsHookReport({ event: 'start', source: 'fork' }, PARENT)).toBe(false)
    })

    it('accepts the first start on an unbound tab', () => {
      expect(
        ownsHookReport({ event: 'start', source: 'startup', sessionId: PARENT }, undefined)
      ).toBe(true)
    })

    it('accepts an in-TUI /resume that moves the tab to another session', () => {
      expect(ownsHookReport({ event: 'start', source: 'resume', sessionId: FORK }, PARENT)).toBe(
        true
      )
    })

    it('accepts /clear, which re-inits the tab under a new session id', () => {
      expect(ownsHookReport({ event: 'start', source: 'clear', sessionId: 'new-id' }, PARENT)).toBe(
        true
      )
    })

    it('accepts an auto-compaction restart of the same session', () => {
      expect(ownsHookReport({ event: 'start', source: 'compact', sessionId: PARENT }, PARENT)).toBe(
        true
      )
    })

    it("rejects a background copy's auto-compaction, since compaction never moves a session to a new id", () => {
      expect(ownsHookReport({ event: 'start', source: 'compact', sessionId: FORK }, PARENT)).toBe(
        false
      )
    })

    it('accepts a start with no source (claude too old to send one)', () => {
      expect(ownsHookReport({ event: 'start', sessionId: PARENT }, PARENT)).toBe(true)
    })

    it('rejects a sourceless start whose id disagrees with the binding', () => {
      expect(ownsHookReport({ event: 'start', sessionId: FORK }, PARENT)).toBe(false)
    })
  })

  describe('SessionEnd', () => {
    it("accepts the end of the tab's own session", () => {
      expect(ownsHookReport({ event: 'end', sessionId: PARENT }, PARENT)).toBe(true)
    })

    it('rejects the end of a forked background copy', () => {
      expect(ownsHookReport({ event: 'end', sessionId: FORK }, PARENT)).toBe(false)
    })

    it('accepts an end with no session id (claude too old to send one)', () => {
      expect(ownsHookReport({ event: 'end' }, PARENT)).toBe(true)
    })
  })

  describe('run-state reports', () => {
    it.each(['prompt', 'stop', 'notify'])("accepts the tab's own %s", (event) => {
      expect(ownsHookReport({ event, sessionId: PARENT }, PARENT)).toBe(true)
    })

    it.each(['prompt', 'stop', 'notify'])("rejects a forked copy's %s", (event) => {
      expect(ownsHookReport({ event, sessionId: FORK }, PARENT)).toBe(false)
    })

    it.each(['prompt', 'stop', 'notify'])('accepts %s with no session id', (event) => {
      expect(ownsHookReport({ event }, PARENT)).toBe(true)
    })
  })

  describe('unbound tab', () => {
    it('accepts a run-state report when the tab drives no session yet', () => {
      expect(ownsHookReport({ event: 'stop', sessionId: FORK }, undefined)).toBe(true)
    })

    it('accepts an end when the tab drives no session yet', () => {
      expect(ownsHookReport({ event: 'end', sessionId: FORK }, '')).toBe(true)
    })
  })
})

describe('makeDropDedupe: a remote report re-pulled unchanged is dropped, so it never re-seeds its session', () => {
  it('lets a file through only when its contents moved', () => {
    const isNews = makeDropDedupe()
    expect(isNews('/m/a.json', '{"event":"start"}')).toBe(true)
    expect(isNews('/m/a.json', '{"event":"start"}')).toBe(false)
    expect(isNews('/m/a.json', '{"event":"stop"}')).toBe(true)
    expect(isNews('/m/b.json', '{"event":"stop"}')).toBe(true)
    expect(isNews('/m/a.json', '{"event":"start"}')).toBe(true)
  })
})
