import fs from 'fs'
import os from 'os'
import path from 'path'
import { describe, expect, it } from 'vitest'
import { CodexAccountPicker, limitsFrom, prepareCodexHome } from '../../src/main/codexAccounts'
import { windowLabel } from '../../src/shared/accountUsage'
import type { AccountView } from '../../src/shared/types'

const account = (name: string, over: Partial<AccountView> = {}): AccountView => ({
  name,
  kind: 'codex-home',
  enabled: true,
  fable: 'unknown',
  status: 'ok',
  addedAt: 0,
  ...over
})

const used = (fraction: number) => ({
  windows: [{ minutes: 10080, used: fraction, resetsAt: 0 }],
  at: 1
})

// CODEX§15
describe('limitsFrom (the rate-limit reply a Codex login gives)', () => {
  it('reads the weekly-only window a Pro login reported, and a short window when there is one', () => {
    const reply = {
      rateLimits: {
        limitId: 'codex',
        primary: { usedPercent: 85, windowDurationMins: 10080, resetsAt: 1790268981 },
        secondary: null,
        planType: 'pro'
      }
    }
    expect(limitsFrom(reply, 5)).toEqual({
      windows: [{ minutes: 10080, used: 0.85, resetsAt: 1790268981 }],
      at: 5
    })
    const both = {
      rateLimits: {
        primary: { usedPercent: 40, windowDurationMins: 10080 },
        secondary: { usedPercent: 10, windowDurationMins: 300, resetsAt: 9 }
      }
    }
    expect(limitsFrom(both, 5)?.windows.map((w) => windowLabel(w.minutes))).toEqual(['5h', '7d'])
  })

  it('has nothing to show when the reply carries no limits', () => {
    expect(limitsFrom({ rateLimits: null }, 5)).toBeUndefined()
  })
})

describe('CodexAccountPicker', () => {
  it('picks the enabled, signed-in account with the most room left, skipping one that is used up', () => {
    const picker = new CodexAccountPicker()
    const pool = [
      account('full', { limits: used(1) }),
      account('busy', { limits: used(0.7) }),
      account('light', { limits: used(0.2) }),
      account('off', { enabled: false, limits: used(0) }),
      account('out', { status: 'expired', limits: used(0) }),
      account('claude', { kind: 'oauth' })
    ]
    expect(picker.pick(pool)?.name).toBe('light')
  })

  it('takes turns when no account has been measured yet, and picks none when there is no Codex account', () => {
    const picker = new CodexAccountPicker()
    const pool = [account('a'), account('b')]
    expect([picker.pick(pool)?.name, picker.pick(pool)?.name, picker.pick(pool)?.name]).toEqual([
      'a',
      'b',
      'a'
    ])
    expect(picker.pick([account('claude', { kind: 'oauth' })])).toBeUndefined()
  })
})

describe('prepareCodexHome', () => {
  it('links the shared config.toml into a new home so settings and folder trust stay one, and never replaces a file already there', () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codex-home-')))
    const shared = path.join(dir, 'shared.toml')
    fs.writeFileSync(shared, 'model = "gpt-5"\n')
    const home = path.join(dir, 'homes', 'work')
    prepareCodexHome(home, shared)
    expect(fs.readlinkSync(path.join(home, 'config.toml'))).toBe(shared)

    const own = path.join(dir, 'homes', 'own')
    fs.mkdirSync(own, { recursive: true })
    fs.writeFileSync(path.join(own, 'config.toml'), 'model = "o3"\n')
    prepareCodexHome(own, shared)
    expect(fs.lstatSync(path.join(own, 'config.toml')).isSymbolicLink()).toBe(false)
    fs.rmSync(dir, { recursive: true, force: true })
  })
})
