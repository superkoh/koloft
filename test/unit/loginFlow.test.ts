import { describe, it, expect } from 'vitest'
import {
  loginClearDelay,
  progressOfTheOpenBox,
  savedClearDue,
  type LoginFlowState
} from '../../src/renderer/src/components/settings/loginFlow'
import type { LoginProgress } from '@shared/types'

const p = (phase: LoginProgress['phase']): LoginProgress =>
  ({ phase, name: 'work' }) as LoginProgress

describe('loginClearDelay (FR-06 terminal phases)', () => {
  it('saved auto-clears after the 1.2s beat', () => {
    expect(loginClearDelay(p('saved'))).toBe(1200)
  })

  it('failed persists until acknowledged; live phases never auto-clear', () => {
    expect(loginClearDelay(p('failed'))).toBeNull()
    expect(loginClearDelay(p('starting'))).toBeNull()
    expect(loginClearDelay(p('browser'))).toBeNull()
  })
})

describe('savedClearDue (stale-timer guard)', () => {
  it('clears when the slice still holds the exact scheduled progress', () => {
    const saved = p('saved')
    const cur: LoginFlowState = { kind: 'oauth', progress: saved }
    expect(savedClearDue(cur, saved)).toBe(true)
  })

  it('does not clear a newer login that replaced the scheduled one', () => {
    const saved = p('saved')
    const cur: LoginFlowState = { kind: 'oauth', progress: p('starting') }
    expect(savedClearDue(cur, saved)).toBe(false)
  })

  it('takes only the progress of the kind the open box signs in, never a tab sign-in’s', () => {
    const box: LoginFlowState = { kind: 'oauth', progress: null }
    expect(
      progressOfTheOpenBox(box, {
        kind: 'oauth',
        name: 'work',
        again: false,
        phase: 'failed',
        tail: 'gone',
        tab: { tabId: 't1', cwd: '/h' }
      })
    ).toEqual({ phase: 'failed', name: 'work', tail: 'gone', tabId: 't1', cwd: '/h' })
    expect(
      progressOfTheOpenBox(box, { kind: 'codex-home', name: 'work', again: false, phase: 'failed' })
    ).toBeNull()
    expect(
      progressOfTheOpenBox(null, { kind: 'oauth', name: 'w', again: false, phase: 'saved' })
    ).toBeNull()
  })

  it('is a no-op when the slice is already empty', () => {
    expect(savedClearDue(null, p('saved'))).toBe(false)
    expect(savedClearDue({ kind: 'oauth', progress: null }, p('saved'))).toBe(false)
  })
})
