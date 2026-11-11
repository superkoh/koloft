import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AccountView, CodexLimits, QuotaBucket, SignInFolderKind } from '@shared/types'
import { HomeAccountPicker } from '../../src/main/codexAccounts'
import { SavedUsage, SNAPSHOT_OLDER_THAN_THE_5H_WINDOW_MS } from '../../src/main/savedUsage'
import { saveHomeUsage, withSavedHomeUsage, type HomeUsage } from '../../src/main/savedHomeUsage'

const WEEK_MINUTES = 7 * 24 * 60
const dirs: string[] = []

function snapshotFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-home-usage-'))
  dirs.push(dir)
  return path.join(dir, 'home-usage-snapshots.json')
}

afterEach(() => {
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

describe('usage of Codex, Muse and Antigravity accounts kept across a restart', () => {
  it.each<[SignInFolderKind, (used: number, nowMs: number) => Partial<AccountView>]>([
    ['codex-home', (used, nowMs) => ({ limits: weekLimits(used, nowMs) })],
    ['muse-home', (used, nowMs) => ({ limits: weekLimits(used, nowMs) })],
    ['agy-home', (used, nowMs) => ({ quota: weekQuota(used, nowMs) })]
  ])(
    'a %s account read as full before Koloft closed is passed over on the first pick after it reopens, with no read answered yet',
    (kind, usage) => {
      const file = snapshotFile()
      const nowMs = Date.now()
      const before = new SavedUsage<HomeUsage>(file, nowMs)
      saveHomeUsage(before, { name: 'Full', kind }, usage(1, nowMs), nowMs)
      saveHomeUsage(before, { name: 'roomy', kind }, usage(0.1, nowMs), nowMs)

      const after = reopened(file, before, nowMs + 60_000)
      const nothingReadYet = [account('Full', kind), account('roomy', kind)]

      expect(new HomeAccountPicker(kind).pick(nothingReadYet)?.name).toBe('Full')
      expect(
        new HomeAccountPicker(kind).pick(withSavedHomeUsage(nothingReadYet, after))?.name
      ).toBe('roomy')
    }
  )

  it('usage saved longer ago than the 5-hour window is not used', () => {
    const file = snapshotFile()
    const nowMs = Date.now()
    const before = new SavedUsage<HomeUsage>(file, nowMs)
    saveHomeUsage(before, { name: 'a', kind: 'agy-home' }, { quota: weekQuota(1, nowMs) }, nowMs)

    const after = reopened(file, before, nowMs + SNAPSHOT_OLDER_THAN_THE_5H_WINDOW_MS)

    const views = [account('a', 'agy-home')]
    expect(withSavedHomeUsage(views, after)).toEqual(views)
  })

  it('what this run has read wins over what was saved, and a read that failed keeps what was saved', () => {
    const file = snapshotFile()
    const nowMs = Date.now()
    const store = new SavedUsage<HomeUsage>(file, nowMs)
    const a = { name: 'a', kind: 'codex-home' as const }
    saveHomeUsage(store, a, { limits: weekLimits(0.9, nowMs) }, nowMs)
    saveHomeUsage(store, a, { probeError: 'network' }, nowMs)

    const failed = { ...account('a', 'codex-home'), probeError: 'network' as const }
    expect(withSavedHomeUsage([failed], store)[0].limits?.windows[0].used).toBe(0.9)

    const live = { ...account('a', 'codex-home'), limits: weekLimits(0.2, nowMs + 1) }
    expect(withSavedHomeUsage([live], store)[0]).toBe(live)
  })

  it('an account that turns out to run on an API key drops its saved usage', () => {
    const file = snapshotFile()
    const nowMs = Date.now()
    const store = new SavedUsage<HomeUsage>(file, nowMs)
    const a = { name: 'a', kind: 'muse-home' as const }
    saveHomeUsage(store, a, { limits: weekLimits(0.9, nowMs) }, nowMs)
    saveHomeUsage(store, a, { apiKey: true }, nowMs)

    expect(reopened(file, store, nowMs).get('muse-home:a')).toBeUndefined()
  })
})
