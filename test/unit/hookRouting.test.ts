import { describe, it, expect } from 'vitest'
import { makeDropDedupe, ownsHookReport } from '../../src/main/hookRouting'

/*
 * Requirement (fork-compat design layer 1, retired; the CC fork facts
 * behind it live in docs/claude-code-contract.md §5): a hook report may act on a tab
 * only when it belongs to the session that tab is currently driving.
 *
 * Why this needs its own unit: `/fork` spawns a background copy that inherits the
 * parent tab's hook settings, so its reports arrive stamped with the PARENT tab's id.
 * There is no way to produce that situation from an e2e test (it needs a real fork
 * against a live model), and when the rule is wrong the symptom surfaces far from
 * here — a sidebar row going cold, a tab losing its binding minutes later. This
 * predicate is the single place the decision is made.
 *
 * Expected values below are derived from the requirement, never from the code:
 *   - a fork's SessionStart is never this tab's       (its source says so outright)
 *   - any other SessionStart IS this tab's            (/clear and in-TUI /resume move
 *                                                      the tab to a new id on purpose)
 *   - end / run-state reports are this tab's only when the id matches
 *   - a report with no id at all keeps the pre-fix behaviour (older claude)
 */

const PARENT = 'f2954c58-a979-4e3f-92f3-e6aed7806bcb'
const FORK = 'f68fbf6d-b57c-48b5-b2ca-325ce86ddac0'

describe('ownsHookReport', () => {
  describe('SessionStart', () => {
    it('rejects a fork — the copy is a background session, not this tab', () => {
      expect(ownsHookReport({ event: 'start', source: 'fork', sessionId: FORK }, PARENT)).toBe(
        false
      )
    })

    it('rejects a fork even when the report carries no session id', () => {
      // the source alone settles it; the decision must not hinge on the id being parsed
      expect(ownsHookReport({ event: 'start', source: 'fork' }, PARENT)).toBe(false)
    })

    it('accepts the first start on an unbound tab', () => {
      expect(
        ownsHookReport({ event: 'start', source: 'startup', sessionId: PARENT }, undefined)
      ).toBe(true)
    })

    it('accepts an in-TUI /resume that moves the tab to another session', () => {
      // a switch is exactly what SessionStart(source=resume) means — the tab follows it
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

    it("rejects a background copy's auto-compaction", () => {
      // The fork that started this whole mess ran for two days; a copy that long-lived
      // compacts its own history, and that fires SessionStart with source 'compact' —
      // NOT 'fork'. Compaction re-inits a session in place and never moves it to a new
      // id, so a 'compact' naming a session this tab is not driving is somebody else's:
      // honouring it rebinds the tab to the copy, which is the very bug this gate exists
      // to stop. Only clear / resume / startup legitimately move a tab to another id.
      expect(ownsHookReport({ event: 'start', source: 'compact', sessionId: FORK }, PARENT)).toBe(
        false
      )
    })

    it('accepts a start with no source (claude too old to send one)', () => {
      expect(ownsHookReport({ event: 'start', sessionId: PARENT }, PARENT)).toBe(true)
    })

    it('rejects a sourceless start whose id disagrees with the binding', () => {
      // A start that does not say why it started is claiming nothing; if the hook's
      // source extraction ever fails on a fork (same sed, same failure modes as the id),
      // 'no source' is exactly what a fork's start looks like. Claiming continuity while
      // naming a different session is the one combination that is never legitimate.
      expect(ownsHookReport({ event: 'start', sessionId: FORK }, PARENT)).toBe(false)
    })
  })

  describe('SessionEnd', () => {
    it("accepts the end of the tab's own session", () => {
      expect(ownsHookReport({ event: 'end', sessionId: PARENT }, PARENT)).toBe(true)
    })

    it('rejects the end of a forked background copy', () => {
      // the copy exits with reason prompt_input_exit — the same reason Koloft treats as
      // "the user quit this tab's session", which is what strands the live tab
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
      // otherwise the copy's turns drive this tab's status dot and turn-done alerts
      expect(ownsHookReport({ event, sessionId: FORK }, PARENT)).toBe(false)
    })

    it.each(['prompt', 'stop', 'notify'])('accepts %s with no session id', (event) => {
      expect(ownsHookReport({ event }, PARENT)).toBe(true)
    })
  })

  describe('unbound tab', () => {
    it('accepts a run-state report when the tab drives no session yet', () => {
      // nothing to compare against — keep the pre-fix behaviour rather than drop it
      expect(ownsHookReport({ event: 'stop', sessionId: FORK }, undefined)).toBe(true)
    })

    it('accepts an end when the tab drives no session yet', () => {
      expect(ownsHookReport({ event: 'end', sessionId: FORK }, '')).toBe(true)
    })
  })
})

// A remote tab's reports arrive by rsync into a mirror, and the whole folder is pulled
// again every couple of seconds. Re-delivering an unchanged SessionStart re-seeds the
// session to 'waiting' — mid-turn that reads as a finished turn, wiping the parked
// badge and firing a phantom turn-done.
describe('makeDropDedupe', () => {
  it('lets a file through only when its contents moved', () => {
    const isNews = makeDropDedupe()
    expect(isNews('/m/a.json', '{"event":"start"}')).toBe(true)
    expect(isNews('/m/a.json', '{"event":"start"}')).toBe(false)
    expect(isNews('/m/a.json', '{"event":"stop"}')).toBe(true)
    // a second tab's file is its own story
    expect(isNews('/m/b.json', '{"event":"stop"}')).toBe(true)
    // coming back to the earlier text is a change too, and so is news
    expect(isNews('/m/a.json', '{"event":"start"}')).toBe(true)
  })
})
