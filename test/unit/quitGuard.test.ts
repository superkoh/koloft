import { beforeEach, describe, expect, it } from 'vitest'
import {
  approve,
  approveAndRun,
  declineQuit,
  QUIT_ANSWER_GRACE_MS,
  quitDecision,
  reset,
  setQuitAsk,
  withApproval
} from '../../src/main/quitGuard'

// file-edit B-26 — the most expensive of the three unsaved-changes guards, because
// Electron's `before-quit` is SYNCHRONOUS: it cannot wait for an answer, so quitting
// has to be turned into "block, ask, remember the answer, quit again". The whole
// decision lives here as a latch over a clock so the two branches an end-to-end test
// can never reach are still pinned: a second ⌘Q landing while the question is already
// on screen, and a renderer that never answers at all.
//
// The times below are hand-picked round numbers; the only real arithmetic is the
// grace window, taken from the exported constant rather than the literal 5000 so the
// case still means "at the deadline" if the constant ever moves.

beforeEach(() => declineQuit())

describe('quitDecision (B-26 quit latch)', () => {
  it('asks on the first ⌘Q — nothing has been approved yet', () => {
    expect(quitDecision(1000)).toBe('ask')
  })

  it('waits, rather than asking twice, while the first question is unanswered', () => {
    expect(quitDecision(1000)).toBe('ask')
    expect(quitDecision(1200)).toBe('wait')
    expect(quitDecision(1400)).toBe('wait')
  })

  it('honours an approval given BEFORE the question was ever asked', () => {
    // the e2e suite closes the app through the product's own `approveQuit`, with no
    // dialog and no pending quit — a pre-approval has to let the very next quit
    // straight through, or a spec that ends with an unsaved buffer hangs on teardown
    approve()
    expect(quitDecision(1000)).toBe('allow')
  })

  it('allows the quit once the renderer has approved it, and keeps allowing', () => {
    expect(quitDecision(1000)).toBe('ask')
    approve()
    expect(quitDecision(1100)).toBe('allow')
    expect(quitDecision(1200)).toBe('allow')
  })

  it('allows a quit that was never approved once the grace window has run out', () => {
    expect(quitDecision(1000)).toBe('ask')
    expect(quitDecision(1000 + QUIT_ANSWER_GRACE_MS - 1)).toBe('wait')
    expect(quitDecision(1000 + QUIT_ANSWER_GRACE_MS)).toBe('allow')
  })

  it('starts asking from scratch after a reset, deadline and all', () => {
    expect(quitDecision(1000)).toBe('ask')
    // the renderer took the question — the user is looking at the dialog now, so the
    // silence deadline must NOT keep running against them
    reset()
    expect(quitDecision(1000 + QUIT_ANSWER_GRACE_MS * 2)).toBe('ask')
  })

  it('forgets an approval on reset — a cancelled quit must be asked about again', () => {
    approve()
    reset()
    expect(quitDecision(1000)).toBe('ask')
  })

  // The approval is spent on the quit it was given for. It used to survive the cleanup,
  // so anything that vetoes a quit AFTER `before-quit` has allowed it — a future
  // "sessions are still running" window-close confirmation, say — would leave the latch
  // open and the NEXT ⌘Q would skip the unsaved question entirely.
  it('spends the approval: a quit that was allowed and then abandoned asks again', () => {
    quitDecision(1000)
    approve()
    expect(quitDecision(1100)).toBe('allow')
    reset() // what the allow branch does once it has finished tearing down
    expect(quitDecision(1200)).toBe('ask')
  })
})

// Two paths END THE PROCESS without going through `before-quit` first: the updater
// spawns a detached script that waits ~30s for our PID and then swaps the app bundle,
// and Restart arms `app.relaunch()`. Both used to fire before the unsaved question was
// even asked, so a user who thought about it for half a minute got the bundle replaced
// underneath a running Koloft, and a user who cancelled got a relaunch that stayed armed
// and reopened the app at the next ordinary quit. So neither may act before the answer.
describe('withApproval (B-26: ask before anything irreversible)', () => {
  const ran: string[] = []
  const act = (): void => void ran.push('did it')

  beforeEach(() => {
    ran.length = 0
    setQuitAsk(() => true)
  })

  it('acts at once when there is no renderer to ask — nothing can be unsaved', () => {
    setQuitAsk(() => false)
    expect(withApproval(act, 1000)).toBe('ran')
    expect(ran).toEqual(['did it'])
  })

  it('acts at once when the quit is already approved', () => {
    approve()
    expect(withApproval(act, 1000)).toBe('ran')
    expect(ran).toEqual(['did it'])
  })

  it('waits for the answer, then acts on approval — and not the plain quit instead', () => {
    const fallback = (): void => void ran.push('plain quit')
    expect(withApproval(act, 1000)).toBe('waiting')
    expect(ran).toEqual([])
    approveAndRun(fallback)
    expect(ran).toEqual(['did it'])
  })

  it('never acts when the user cancels, and does not act on a LATER quit either', () => {
    const fallback = (): void => void ran.push('plain quit')
    expect(withApproval(act, 1000)).toBe('waiting')
    declineQuit()
    expect(ran).toEqual([])
    // the armed action must not be left lying around for the next ⌘Q to trip over
    expect(quitDecision(2000)).toBe('ask')
    approveAndRun(fallback)
    expect(ran).toEqual(['plain quit'])
  })

  it('unwinds the caller on a cancel — the installer must not stay latched', () => {
    withApproval(act, 1000, () => void ran.push('unwound'))
    declineQuit()
    expect(ran).toEqual(['unwound'])
  })

  it('does not unwind once the action has gone ahead', () => {
    withApproval(act, 1000, () => void ran.push('unwound'))
    approveAndRun(() => {})
    declineQuit()
    expect(ran).toEqual(['did it'])
  })

  it('falls back to the plain quit when nothing was waiting', () => {
    const fallback = (): void => void ran.push('plain quit')
    approveAndRun(fallback)
    expect(ran).toEqual(['plain quit'])
  })
})
