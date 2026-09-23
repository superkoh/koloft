import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { WebglAddon } from '@xterm/addon-webgl'
import {
  registerWebglRepair,
  unregisterWebglRepair,
  repairAllWebgl
} from '../../src/renderer/src/webglRepair'

// The glyph atlas is SHARED across every terminal with matching config, so both
// repair paths must reach EVERY live tab, not just the one that triggered them:
// a merge (or a clear) that only heals its own tab leaves the siblings rendering
// stale coords into a changed atlas — the exact upstream defect (#5883/#6014).

type FakeAddon = {
  cleared: number
  mergeListeners: Array<() => void>
  clearTextureAtlas: () => void
  onRemoveTextureAtlasCanvas: (cb: () => void) => { dispose: () => void }
}

function fakeAddon(): FakeAddon {
  const a: FakeAddon = {
    cleared: 0,
    mergeListeners: [],
    clearTextureAtlas() {
      a.cleared++
    },
    onRemoveTextureAtlasCanvas(cb: () => void) {
      a.mergeListeners.push(cb)
      return {
        dispose: () => {
          const i = a.mergeListeners.indexOf(cb)
          if (i >= 0) a.mergeListeners.splice(i, 1)
        }
      }
    }
  }
  return a
}

const asAddon = (a: unknown): WebglAddon => a as WebglAddon

const registered: string[] = []
function register(id: string, addon: unknown, refresh: () => void): void {
  registerWebglRepair(id, asAddon(addon), refresh)
  registered.push(id)
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  // the module keeps a singleton registry — drain it so tests stay independent
  for (const id of registered.splice(0)) unregisterWebglRepair(id)
  vi.useRealTimers()
})

describe('webglRepair: merge-triggered healing frame', () => {
  it('a page merge refreshes EVERY live tab, not just the one that merged', () => {
    const a = fakeAddon()
    const b = fakeAddon()
    const refreshed: string[] = []
    register('a', a, () => refreshed.push('a'))
    register('b', b, () => refreshed.push('b'))

    a.mergeListeners.forEach((cb) => cb()) // merge signal lands on tab a only
    expect(refreshed).toEqual([]) // debounced — nothing synchronous
    vi.advanceTimersByTime(60)
    expect(refreshed.sort()).toEqual(['a', 'b'])
  })

  it('coalesces a burst of merge signals into one refresh per tab', () => {
    const a = fakeAddon()
    const refreshed: string[] = []
    register('a', a, () => refreshed.push('a'))

    for (let i = 0; i < 5; i++) {
      a.mergeListeners.forEach((cb) => cb())
      vi.advanceTimersByTime(10) // within the debounce window
    }
    vi.advanceTimersByTime(100)
    expect(refreshed).toEqual(['a'])
  })

  it('an unregistered tab stops receiving refreshes and its merge listener is disposed', () => {
    const a = fakeAddon()
    const b = fakeAddon()
    const refreshed: string[] = []
    register('a', a, () => refreshed.push('a'))
    register('b', b, () => refreshed.push('b'))

    unregisterWebglRepair('b')
    expect(b.mergeListeners).toHaveLength(0) // subscription actually disposed

    a.mergeListeners.forEach((cb) => cb())
    vi.advanceTimersByTime(60)
    expect(refreshed).toEqual(['a'])
  })
})

describe('webglRepair: repairAllWebgl (webgl:repair IPC path)', () => {
  it('clears the atlas via every live addon and refreshes every tab', () => {
    const a = fakeAddon()
    const b = fakeAddon()
    const refreshed: string[] = []
    register('a', a, () => refreshed.push('a'))
    register('b', b, () => refreshed.push('b'))

    repairAllWebgl()
    // per-addon clear: the shared atlas is wiped once (siblings no-op on the emptied
    // atlas inside xterm) AND each addon rebuilds its own vertex model
    expect(a.cleared).toBe(1)
    expect(b.cleared).toBe(1)
    expect(refreshed.sort()).toEqual(['a', 'b'])
  })

  it('one addon throwing on clear does not block repairing the others', () => {
    const bad = {
      clearTextureAtlas() {
        throw new Error('context already lost')
      }
    }
    const good = fakeAddon()
    const refreshed: string[] = []
    register('bad', bad, () => refreshed.push('bad'))
    register('good', good, () => refreshed.push('good'))

    expect(() => repairAllWebgl()).not.toThrow()
    expect(good.cleared).toBe(1)
    expect(refreshed.sort()).toEqual(['bad', 'good'])
  })

  it('an addon without onRemoveTextureAtlasCanvas (future drift) still registers and repairs', () => {
    const minimal = {
      cleared: 0,
      clearTextureAtlas() {
        minimal.cleared++
      }
    }
    const refreshed: string[] = []
    expect(() => register('m', minimal, () => refreshed.push('m'))).not.toThrow()

    repairAllWebgl()
    expect(minimal.cleared).toBe(1)
    expect(refreshed).toEqual(['m'])
  })
})
