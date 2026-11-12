import { describe, expect, it } from 'vitest'
import {
  assistBackendsFor,
  assistEfforts,
  assistLaunchOn,
  assistRunsOn,
  withAssistPick
} from '../../src/shared/assistPicks'
import { DEFAULT_SETTINGS, type AssistSetting } from '../../src/shared/types'
import { meta } from './helpers/accounts'

const METHODS = DEFAULT_SETTINGS.sessionMethods

const withAccounts = (assist: AssistSetting, ...accounts: ReturnType<typeof meta>[]) => ({
  assist,
  sessionMethods: METHODS,
  accounts
})

describe('which tool Assist runs on when the owner never chose one', () => {
  it('is the tool of the account added first that can still be used, and the default method only when no account can', () => {
    const codexFirst = [
      meta({ name: 'late', kind: 'oauth', addedAt: 30 }),
      meta({ name: 'early', kind: 'codex-home', addedAt: 10 }),
      meta({ name: 'gone', kind: 'agy-home', addedAt: 1, status: 'expired' }),
      meta({ name: 'off', kind: 'muse-home', addedAt: 2, enabled: false })
    ]
    expect(assistRunsOn(withAccounts({}, ...codexFirst))).toBe('codex')
    expect(assistRunsOn(withAccounts({}))).toBe(METHODS.defaultBackend)
  })

  it('skips a tool switched off in Settings ▸ Sessions, and takes records with no date in the order they were added', () => {
    const s = {
      assist: {},
      sessionMethods: { ...METHODS, enabled: { ...METHODS.enabled, agy: false } },
      accounts: [
        meta({ name: 'x', kind: 'agy-home', addedAt: 0 }),
        meta({ name: 'y', kind: 'muse-home', addedAt: 0 }),
        meta({ name: 'z', kind: 'oauth', addedAt: 0 })
      ]
    }
    expect(assistRunsOn(s)).toBe('muse')
  })

  it('is the owner’s choice once there is one, and a job with its own tool tries that first, then that choice, then the rest by account age', () => {
    const s = withAccounts(
      { backend: 'claude', rows: { route: { backend: 'agy' } } },
      meta({ kind: 'codex-home', addedAt: 1 }),
      meta({ kind: 'oauth', addedAt: 2 })
    )
    expect(assistRunsOn(s)).toBe('claude')
    expect(assistBackendsFor('route', s)).toEqual(['agy', 'claude', 'codex', 'muse'])
    expect(assistBackendsFor('title', s)).toEqual(['claude', 'codex', 'muse', 'agy'])
  })
})

describe('the model and thinking a job runs with', () => {
  const on = (assist: AssistSetting) => withAccounts(assist)

  it('come from Koloft’s table for that job and tool while the job has no pick', () => {
    expect(assistLaunchOn('turn', 'codex', on({ backend: 'codex' }))).toEqual({
      model: 'gpt-6.1-sol',
      effort: 'medium',
      modelFromTheTable: true,
      effortFromTheTable: true
    })
    expect(assistLaunchOn('title', 'claude', on({}))).toMatchObject({ model: 'haiku' })
    expect(assistLaunchOn('butler', 'claude', on({}))).toEqual({
      modelFromTheTable: true,
      effortFromTheTable: true
    })
  })

  it('take the job’s own model and thinking each on its own, and only on the tool the pick names, even after Assist moves to another tool', () => {
    const rows = {
      turn: { backend: 'claude' as const, model: 'opus' },
      route: { backend: 'claude' as const, effort: 'high' as const }
    }
    for (const backend of ['claude', 'codex'] as const) {
      const s = on({ backend, rows })
      expect(assistLaunchOn('turn', 'claude', s)).toEqual({
        model: 'opus',
        modelFromTheTable: false,
        effortFromTheTable: true
      })
      expect(assistLaunchOn('route', 'claude', s)).toEqual({
        model: 'sonnet',
        effort: 'high',
        modelFromTheTable: true,
        effortFromTheTable: false
      })
      expect(assistLaunchOn('turn', 'codex', s)).toMatchObject({
        model: 'gpt-6.1-sol',
        effort: 'medium',
        modelFromTheTable: true
      })
      expect(assistBackendsFor('turn', s)[0]).toBe('claude')
    }
  })

  // AGY§21
  it('drop a thinking level the model does not take', () => {
    const s = on({ rows: { turn: { backend: 'agy', model: 'gemini-3.1-pro' } } })
    expect(assistLaunchOn('turn', 'agy', s)).toEqual({
      model: 'gemini-3.1-pro',
      modelFromTheTable: false,
      effortFromTheTable: true
    })
  })

  it('offer a small job every level but Max, and the butler all of them', () => {
    expect(assistEfforts('turn', 'claude', 'haiku')).toEqual(['low', 'medium', 'high', 'xhigh'])
    expect(assistEfforts('butler', 'claude', undefined)).toContain('max')
  })
})

describe('saving a job’s pick', () => {
  it('keeps the other jobs’ picks, and a pick emptied back to Default leaves no record', () => {
    const picked = withAssistPick({ backend: 'codex' }, 'turn', {
      model: 'opus',
      backend: 'claude'
    })
    expect(picked).toEqual({
      backend: 'codex',
      rows: { turn: { model: 'opus', backend: 'claude' } }
    })
    expect(withAssistPick(picked, 'turn', undefined)).toEqual({ backend: 'codex' })
  })
})
