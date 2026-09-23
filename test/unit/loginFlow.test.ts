import { describe, it, expect } from 'vitest'
import {
  loginClearDelay,
  savedClearDue,
  type LoginFlowState
} from '../../src/renderer/src/components/settings/loginFlow'
import type { LoginProgress } from '@shared/types'

// Expectations hand-derived from FR-06
//: saved
// auto-clears after its 1.2s beat, failed persists until acknowledged, live phases
// never auto-clear; a timer that outlives its login must not clear a newer one.

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
    const cur: LoginFlowState = { progress: saved }
    expect(savedClearDue(cur, saved)).toBe(true)
  })

  it('does not clear a newer login that replaced the scheduled one', () => {
    const saved = p('saved')
    const cur: LoginFlowState = { progress: p('starting') }
    expect(savedClearDue(cur, saved)).toBe(false)
  })

  it('is a no-op when the slice is already empty', () => {
    expect(savedClearDue(null, p('saved'))).toBe(false)
    expect(savedClearDue({ progress: null }, p('saved'))).toBe(false)
  })
})
