import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AccountView, CodexLimits, QuotaBucket, SignInFolderKind } from '@shared/types'
import { launchLine } from '@shared/accountUsage'
import { BackgroundFile } from '../../src/main/backgroundFile'
import { HomeAccountPicker } from '../../src/main/codexAccounts'
import { SavedUsage, SNAPSHOT_OLDER_THAN_THE_5H_WINDOW_MS } from '../../src/main/savedUsage'
import { saveHomeUsage, type HomeUsage } from '../../src/main/savedHomeUsage'

const WEEK_MINUTES = 7 * 24 * 60
const dirs: string[] = []

function snapshotFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-home-usage-'))
  dirs.push(dir)
  return path.join(dir, 'home-usage-snapshots.json')
}

afterEach(async () => {
  await BackgroundFile.whenAllWritten()
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function account(name: string, kind: SignInFolderKind): AccountView {
  return { name, kind, enabled: true, fable: 'unknown', status: 'ok', addedAt: 1 }
}

function weekLimits(used: number, at: number): CodexLimits {
  return {
    windows: [{ minutes: WEEK_MINUTES, used, resetsAt: Math.floor(at / 1000) + 3 * 24 * 3600 }],
    at,
    ...(used >= 1 && { reached: true })
  }
}

function weekQuota(used: number, nowMs: number): QuotaBucket[] {
  return [
    {
      label: 'Gemini · weekly',
      used,
      minutes: WEEK_MINUTES,
      resetsAt: Math.floor(nowMs / 1000) + 3 * 24 * 3600
    }
  ]
}

function reopened(
  file: string,
  store: SavedUsage<HomeUsage>,
  nowMs: number
): SavedUsage<HomeUsage> {
  store.flushSync()
  return new SavedUsage<HomeUsage>(file, nowMs)
}

function pickerOver(kind: SignInFolderKind, store: SavedUsage<HomeUsage>): HomeAccountPicker {
  return new HomeAccountPicker(kind, (a) => store.get(a.name))
}

describe('usage of Codex, Muse and Antigravity accounts kept across a restart', () => {
  it.each<[SignInFolderKind, (used: number, nowMs: number) => Partial<AccountView>]>([
    ['codex-home', (used, nowMs) => ({ limits: weekLimits(used, nowMs) })],
    ['muse-home', (used, nowMs) => ({ limits: weekLimits(used, nowMs) })],
    ['agy-home', (used, nowMs) => ({ quota: weekQuota(used, nowMs), quotaAt: nowMs })]
  ])(
    'a %s account read as full before Koloft closed is passed over on the first pick after it reopens, with no read answered yet',
    (kind, usage) => {
      const file = snapshotFile()
      const nowMs = Date.now()
      const before = new SavedUsage<HomeUsage>(file, nowMs)
      saveHomeUsage(before, 'full', usage(1, nowMs))
      saveHomeUsage(before, 'roomy', usage(0.1, nowMs))

      const after = reopened(file, before, nowMs + 60_000)
      const nothingReadYet = [account('full', kind), account('roomy', kind)]

      expect(new HomeAccountPicker(kind).pick(nothingReadYet)?.name).toBe('full')
      expect(pickerOver(kind, after).pick(nothingReadYet)?.name).toBe('roomy')
    }
  )

  it.each<[SignInFolderKind, (used: number, at: number) => Partial<AccountView>]>([
    ['codex-home', (used, at) => ({ limits: weekLimits(used, at) })],
    ['muse-home', (used, at) => ({ limits: weekLimits(used, at) })],
    ['agy-home', (used, at) => ({ quota: weekQuota(used, at), quotaAt: at })]
  ])(
    'a %s account picked on usage read two hours before Koloft reopened says on its launch line that the usage is 2 h old',
    (kind, usage) => {
      const file = snapshotFile()
      const nowMs = Date.now()
      const readAt = nowMs - 2 * 3600_000
      const before = new SavedUsage<HomeUsage>(file, readAt)
      saveHomeUsage(before, 'a', usage(0.1, readAt))

      const picked = pickerOver(kind, reopened(file, before, nowMs)).pick([account('a', kind)])

      expect(launchLine(picked!, nowMs)).toMatch(/^koloft: → a · .* 10% · 2 h ago$/)
    }
  )

  it('usage saved longer ago than the 5-hour window is not used', () => {
    const file = snapshotFile()
    const nowMs = Date.now()
    const before = new SavedUsage<HomeUsage>(file, nowMs)
    saveHomeUsage(before, 'full', { quota: weekQuota(1, nowMs), quotaAt: nowMs })
    saveHomeUsage(before, 'roomy', { quota: weekQuota(0.1, nowMs), quotaAt: nowMs })

    const after = reopened(file, before, nowMs + SNAPSHOT_OLDER_THAN_THE_5H_WINDOW_MS)

    const nothingReadYet = [account('full', 'agy-home'), account('roomy', 'agy-home')]
    expect(pickerOver('agy-home', after).pick(nothingReadYet)?.name).toBe('full')
  })

  it('what this run has read wins over what was saved, and a read that failed keeps what was saved', () => {
    const nowMs = Date.now()
    const store = new SavedUsage<HomeUsage>(snapshotFile(), nowMs)
    saveHomeUsage(store, 'a', { limits: weekLimits(1, nowMs) })
    saveHomeUsage(store, 'b', { limits: weekLimits(0.5, nowMs) })
    saveHomeUsage(store, 'a', { probeError: 'network' })
    const picker = pickerOver('codex-home', store)

    const aFailed = { ...account('a', 'codex-home'), probeError: 'network' as const }
    expect(picker.pick([aFailed, account('b', 'codex-home')])?.name).toBe('b')

    const aReadEmpty = { ...account('a', 'codex-home'), limits: weekLimits(0, nowMs + 1) }
    expect(picker.pick([aReadEmpty, account('b', 'codex-home')])?.name).toBe('a')
  })

  it.each([
    [0.9, 'a'],
    [0.96, 'b']
  ])(
    'a session resumed on an account saved at %f of its week runs on %s on the first pick after a reopen',
    (used, runsOn) => {
      const nowMs = Date.now()
      const store = new SavedUsage<HomeUsage>(snapshotFile(), nowMs)
      saveHomeUsage(store, 'a', { limits: weekLimits(used, nowMs) })
      saveHomeUsage(store, 'b', { limits: weekLimits(0.1, nowMs) })

      const nothingReadYet = [account('a', 'codex-home'), account('b', 'codex-home')]
      expect(pickerOver('codex-home', store).pick(nothingReadYet, 'a')?.name).toBe(runsOn)
    }
  )

  it('an account that turns out to run on an API key drops its saved usage', () => {
    const file = snapshotFile()
    const nowMs = Date.now()
    const store = new SavedUsage<HomeUsage>(file, nowMs)
    saveHomeUsage(store, 'a', { limits: weekLimits(0.9, nowMs) })
    saveHomeUsage(store, 'a', { apiKey: true })

    expect(reopened(file, store, nowMs).get('a')).toBeUndefined()
  })
})
