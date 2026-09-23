import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { WebglAddon } from '@xterm/addon-webgl'
import {
  registerWebglRepair,
  unregisterWebglRepair,
  repairAllWebgl
} from '../../src/renderer/src/webglRepair'

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
  for (const id of registered.splice(0)) unregisterWebglRepair(id)
  vi.useRealTimers()
})

// PLATFORM§23
describe('webglRepair: merge-triggered healing frame', () => {
  it('a page merge refreshes EVERY live tab, not just the one that merged, after a debounce', () => {
    const a = fakeAddon()
    const b = fakeAddon()
    const refreshed: string[] = []
    register('a', a, () => refreshed.push('a'))
    register('b', b, () => refreshed.push('b'))

    a.mergeListeners.forEach((cb) => cb())
    expect(refreshed).toEqual([])
    vi.advanceTimersByTime(60)
    expect(refreshed.sort()).toEqual(['a', 'b'])
  })

  it('coalesces a burst of merge signals into one refresh per tab', () => {
    const a = fakeAddon()
    const refreshed: string[] = []
    register('a', a, () => refreshed.push('a'))

    for (let i = 0; i < 5; i++) {
      a.mergeListeners.forEach((cb) => cb())
      vi.advanceTimersByTime(10)
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
    expect(b.mergeListeners).toHaveLength(0)

    a.mergeListeners.forEach((cb) => cb())
    vi.advanceTimersByTime(60)
    expect(refreshed).toEqual(['a'])
  })
})

// PLATFORM§23
describe('webglRepair: a terminal joining or leaving churns the shared atlas', () => {
  it('a terminal joining clears the atlas and repaints the terminals already there', () => {
    const a = fakeAddon()
    const refreshed: string[] = []
    register('a', a, () => refreshed.push('a'))
    vi.advanceTimersByTime(60)
    a.cleared = 0
    refreshed.length = 0

    register('b', fakeAddon(), () => refreshed.push('b'))
    vi.advanceTimersByTime(60)
    expect(a.cleared).toBe(1)
    expect(refreshed).toContain('a')
  })

  it('a terminal leaving clears the atlas and repaints the terminals that stay', () => {
    const a = fakeAddon()
    const refreshed: string[] = []
    register('a', a, () => refreshed.push('a'))
    register('b', fakeAddon(), () => refreshed.push('b'))
    vi.advanceTimersByTime(60)
    a.cleared = 0
    refreshed.length = 0

    unregisterWebglRepair('b')
    vi.advanceTimersByTime(60)
    expect(a.cleared).toBe(1)
    expect(refreshed).toEqual(['a'])
  })
})

describe('webglRepair: repairAllWebgl (webgl:repair IPC path)', () => {
  it('clears the atlas via every live addon (each rebuilds its own vertex model) and refreshes every tab', () => {
    const a = fakeAddon()
    const b = fakeAddon()
    const refreshed: string[] = []
    register('a', a, () => refreshed.push('a'))
    register('b', b, () => refreshed.push('b'))

    repairAllWebgl()
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
