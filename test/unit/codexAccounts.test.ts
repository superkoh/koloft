import fs from 'fs'
import os from 'os'
import path from 'path'
import { describe, expect, it } from 'vitest'
import { HomeAccountPicker, limitsFrom, prepareCodexHome } from '../../src/main/codexAccounts'
import { codexAllLimitedNotice } from '../../src/main/accountPicker'
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

  it('keeps the credit balance, how many resets are saved with the soonest expiry, and a limit Codex says was reached; a field the reply lacks stays unknown, not zero', () => {
    const reply = {
      rateLimits: {
        primary: { usedPercent: 7, windowDurationMins: 10080, resetsAt: 9 },
        secondary: null,
        credits: { hasCredits: true, unlimited: false, balance: '62500.0000000000' },
        rateLimitReachedType: 'rate_limit_reached'
      },
      rateLimitResetCredits: {
        availableCount: 3,
        credits: [
          { id: 'b', status: 'available', expiresAt: 300 },
          { id: 'a', status: 'available', expiresAt: 200 },
          { id: 'c', status: 'redeemed', expiresAt: 100 }
        ]
      }
    }
    expect(limitsFrom(reply, 5)).toMatchObject({
      reached: true,
      credits: { unlimited: false, balance: 62500 },
      resets: { available: 3, firstExpiresAt: 200 }
    })
    const unlimited = { rateLimits: { credits: { hasCredits: true, unlimited: true } } }
    expect(limitsFrom(unlimited, 5)?.credits).toEqual({ unlimited: true })
    const bare = limitsFrom(
      { rateLimits: { credits: null, rateLimitReachedType: null }, rateLimitResetCredits: null },
      5
    )
    expect(bare).toEqual({ windows: [], at: 5 })
  })

  it('has nothing to show when the reply carries no limits', () => {
    expect(limitsFrom({ rateLimits: null }, 5)).toBeUndefined()
  })
})

describe('picking a Codex account', () => {
  it('picks the enabled, signed-in account with the most room left, skipping one that is used up or that Codex says reached a limit', () => {
    const picker = new HomeAccountPicker('codex-home')
    const pool = [
      account('full', { limits: used(1) }),
      account('busy', { limits: used(0.7) }),
      account('light', { limits: used(0.2) }),
      account('reached', { limits: { ...used(0.1), reached: true } }),
      account('off', { enabled: false, limits: used(0) }),
      account('out', { status: 'expired', limits: used(0) }),
      account('claude', { kind: 'oauth' })
    ]
    expect(picker.pick(pool)?.name).toBe('light')
  })

  it('takes turns when no account has been measured yet, and picks none when there is no Codex account', () => {
    const picker = new HomeAccountPicker('codex-home')
    const pool = [account('a'), account('b')]
    expect([picker.pick(pool)?.name, picker.pick(pool)?.name, picker.pick(pool)?.name]).toEqual([
      'a',
      'b',
      'a'
    ])
    expect(picker.pick([account('claude', { kind: 'oauth' })])).toBeUndefined()
  })

  it('when every account is used up, starts on the one whose limit resets soonest and says so; with room left it says nothing', () => {
    const picker = new HomeAccountPicker('codex-home')
    const walledUntil = (resetsAt: number): AccountView['limits'] => ({
      windows: [
        { minutes: 300, used: 1, resetsAt },
        { minutes: 10080, used: 0.4, resetsAt: resetsAt + 99_999 }
      ],
      at: Date.now()
    })
    const late = account('late', { limits: walledUntil(2_000_000_000) })
    const soon = account('soon', { limits: walledUntil(1_900_000_000) })
    const picked = picker.pick([late, soon])
    expect(picked?.name).toBe('soon')
    expect(codexAllLimitedNotice(picked!)).toMatch(/soon.*\d\d:\d\d/)
    expect(codexAllLimitedNotice(account('light', { limits: used(0.25) }))).toBeUndefined()
  })

  it('a resumed session keeps the account it ran on until that account is past 95% used, and is never stuck on one that cannot run', () => {
    const picker = new HomeAccountPicker('codex-home')
    const pool = (sameUsed?: number, over: Partial<AccountView> = {}): AccountView[] => [
      account('same', { ...(sameUsed !== undefined && { limits: used(sameUsed) }), ...over }),
      account('idle', { limits: used(0) })
    ]
    expect(picker.pick(pool(0.95), 'same')?.name).toBe('same')
    expect(picker.pick(pool(), 'same')?.name).toBe('same')
    expect(picker.pick(pool(0.96), 'same')?.name).toBe('idle')
    expect(picker.pick(pool(0, { enabled: false }), 'same')?.name).toBe('idle')
    expect(picker.pick(pool(0, { status: 'expired' }), 'same')?.name).toBe('idle')
  })
})

describe('prepareCodexHome', () => {
  it('links the shared config.toml into a new home so settings and folder trust stay one', () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codex-home-')))
    const shared = path.join(dir, 'shared.toml')
    fs.writeFileSync(shared, 'model = "gpt-5"\n')
    const home = path.join(dir, 'homes', 'work')
    prepareCodexHome(home, shared)
    expect(fs.readlinkSync(path.join(home, 'config.toml'))).toBe(shared)
    expect(fs.readFileSync(shared, 'utf8')).toBe('model = "gpt-5"\n')
    fs.rmSync(dir, { recursive: true, force: true })
  })

  // CODEX§27
  it('links a home that has a config.toml of its own too: its folder trust tables move into the shared file, each folder once, and its other settings stay only in a kept copy beside the link', () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codex-home-')))
    const shared = path.join(dir, 'shared.toml')
    fs.writeFileSync(shared, 'model = "gpt-5"\n\n[projects."/both"]\ntrust_level = "trusted"\n')
    const own = path.join(dir, 'homes', 'own')
    fs.mkdirSync(own, { recursive: true })
    const ownText =
      'model = "o3"\n\n[projects."/both"]\ntrust_level = "trusted"\n\n' +
      '[tui]\nscreen_reader_detection_done = true\n\n' +
      '[projects."/only-here"]\ntrust_level = "trusted"\n\n' +
      '[projects."/only-here"]\ntrust_level = "trusted"\n'
    fs.writeFileSync(path.join(own, 'config.toml'), ownText)
    prepareCodexHome(own, shared)
    expect(fs.readlinkSync(path.join(own, 'config.toml'))).toBe(shared)
    expect(fs.readFileSync(shared, 'utf8')).toBe(
      'model = "gpt-5"\n\n[projects."/both"]\ntrust_level = "trusted"\n\n' +
        '[projects."/only-here"]\ntrust_level = "trusted"\n'
    )
    expect(fs.readFileSync(path.join(own, 'config.toml.before-shared'), 'utf8')).toBe(ownText)
    fs.rmSync(dir, { recursive: true, force: true })
  })

  // CODEX§15
  it("links a home's sessions, archived_sessions, skills and rules to the default home's, so any account lists and resumes every session and sees the owner's own skills and command rules", () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codex-home-')))
    const shared = path.join(dir, 'dot-codex', 'config.toml')
    const home = path.join(dir, 'homes', 'work')
    prepareCodexHome(home, shared)
    for (const folder of ['sessions', 'archived_sessions', 'skills', 'rules']) {
      expect(fs.readlinkSync(path.join(home, folder))).toBe(path.join(dir, 'dot-codex', folder))
      expect(fs.statSync(path.join(dir, 'dot-codex', folder)).isDirectory()).toBe(true)
    }
    fs.rmSync(dir, { recursive: true, force: true })
  })

  // CODEX§17
  it("a home reads the owner's own AGENTS.md once the owner has one, and keeps an AGENTS.md of its own", () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codex-home-')))
    const shared = path.join(dir, 'dot-codex', 'config.toml')
    const home = path.join(dir, 'homes', 'work')
    prepareCodexHome(home, shared)
    expect(fs.existsSync(path.join(home, 'AGENTS.md'))).toBe(false)
    fs.writeFileSync(path.join(dir, 'dot-codex', 'AGENTS.md'), 'Answer in Chinese.\n')
    prepareCodexHome(home, shared)
    expect(fs.readFileSync(path.join(home, 'AGENTS.md'), 'utf8')).toBe('Answer in Chinese.\n')
    const own = path.join(dir, 'homes', 'own')
    fs.mkdirSync(own, { recursive: true })
    fs.writeFileSync(path.join(own, 'AGENTS.md'), 'Mine.\n')
    prepareCodexHome(own, shared)
    expect(fs.readFileSync(path.join(own, 'AGENTS.md'), 'utf8')).toBe('Mine.\n')
    fs.rmSync(dir, { recursive: true, force: true })
  })

  // CODEX§15
  it("moves a home's own sessions into the shared folder by date before linking it; where both hold a file of one name, the newer one stays", () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codex-home-')))
    const shared = path.join(dir, 'dot-codex', 'config.toml')
    const day = path.join('2026', '10', '05')
    const sharedDay = path.join(dir, 'dot-codex', 'sessions', day)
    fs.mkdirSync(sharedDay, { recursive: true })
    const home = path.join(dir, 'homes', 'work')
    const ownDay = path.join(home, 'sessions', day)
    fs.mkdirSync(ownDay, { recursive: true })
    const write = (file: string, text: string, ageS: number): void => {
      fs.writeFileSync(file, text)
      const at = Date.now() / 1000 - ageS
      fs.utimesSync(file, at, at)
    }
    write(path.join(sharedDay, 'rollout-a.jsonl'), 'default, newer', 10)
    write(path.join(ownDay, 'rollout-a.jsonl'), 'own, older', 100)
    write(path.join(sharedDay, 'rollout-c.jsonl'), 'default, older', 100)
    write(path.join(ownDay, 'rollout-c.jsonl'), 'own, newer', 10)
    write(path.join(ownDay, 'rollout-b.jsonl'), 'own', 10)

    prepareCodexHome(home, shared)

    expect(fs.readFileSync(path.join(sharedDay, 'rollout-a.jsonl'), 'utf8')).toBe('default, newer')
    expect(fs.readFileSync(path.join(sharedDay, 'rollout-c.jsonl'), 'utf8')).toBe('own, newer')
    expect(fs.readFileSync(path.join(sharedDay, 'rollout-b.jsonl'), 'utf8')).toBe('own')
    expect(fs.readFileSync(path.join(home, 'sessions', day, 'rollout-b.jsonl'), 'utf8')).toBe('own')
    prepareCodexHome(home, shared)
    expect(fs.readdirSync(sharedDay).sort()).toEqual([
      'rollout-a.jsonl',
      'rollout-b.jsonl',
      'rollout-c.jsonl'
    ])
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('links a new home even before the shared config.toml exists, by making it empty, so the first Codex start cannot write a home-only file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-home-'))
    const shared = path.join(dir, 'dot-codex', 'config.toml')
    const home = path.join(dir, 'homes', 'work')
    prepareCodexHome(home, shared)
    expect(fs.readlinkSync(path.join(home, 'config.toml'))).toBe(shared)
    expect(fs.readFileSync(shared, 'utf8')).toBe('')
    fs.rmSync(dir, { recursive: true, force: true })
  })
})
