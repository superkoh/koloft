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

beforeEach(() => declineQuit())

describe('B-26: quitDecision: before-quit cannot wait for an answer, so a quit is block, ask, remember the answer, quit again', () => {
  it('asks on the first ⌘Q — nothing has been approved yet', () => {
    expect(quitDecision(1000)).toBe('ask')
  })

  it('waits, rather than asking twice, while the first question is unanswered', () => {
    expect(quitDecision(1000)).toBe('ask')
    expect(quitDecision(1200)).toBe('wait')
    expect(quitDecision(1400)).toBe('wait')
  })

  it('honours an approval given BEFORE the question was ever asked, which is how the e2e suite closes the app without hanging', () => {
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

  it('starts asking from scratch after a reset, deadline and all: once the dialog is up the silence deadline stops running against the user', () => {
    expect(quitDecision(1000)).toBe('ask')
    reset()
    expect(quitDecision(1000 + QUIT_ANSWER_GRACE_MS * 2)).toBe('ask')
  })

  it('forgets an approval on reset — a cancelled quit must be asked about again', () => {
    approve()
    reset()
    expect(quitDecision(1000)).toBe('ask')
  })

  it('spends the approval: a quit that was allowed and then vetoed later asks again on the next quit', () => {
    quitDecision(1000)
    approve()
    expect(quitDecision(1100)).toBe('allow')
    reset()
    expect(quitDecision(1200)).toBe('ask')
  })
})

describe('B-26: withApproval: the updater bundle swap and Restart relaunch skip before-quit, so neither acts before the unsaved answer', () => {
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
