import { describe, it, expect } from 'vitest'
import {
  loadFlag,
  relOf,
  saveFlag,
  showIgnoredKey
} from '../../src/renderer/src/components/filesModel'
import { installLocalStorage } from './localStorageStub'

// A-05 — the switch is remembered per checkout, in the renderer's localStorage.
const store = installLocalStorage()

describe('show-ignored flag storage', () => {
  it('keys on the checkout root, so two worktrees remember separately', () => {
    expect(showIgnoredKey('/a/koloft')).toBe('koloft.ft.showIgnored:/a/koloft')
    expect(showIgnoredKey('/a/koloft/wt/x')).not.toBe(showIgnoredKey('/a/koloft'))
  })

  it('is off when nothing was ever saved', () => {
    expect(loadFlag(showIgnoredKey('/a/koloft'))).toBe(false)
  })

  it('round-trips both ways', () => {
    const key = showIgnoredKey('/a/koloft')
    saveFlag(key, true)
    expect(loadFlag(key)).toBe(true)
    saveFlag(key, false)
    expect(loadFlag(key)).toBe(false)
  })

  it('reads junk as off rather than throwing', () => {
    const key = showIgnoredKey('/a/koloft')
    store.set(key, 'yes')
    expect(loadFlag(key)).toBe(false)
  })
})

// How every surface in the app spells a path: the tree, the Changes rows, the tab titles
// and now the unsaved-changes dialogs all read it through here. Backfilled when those
// dialogs became a caller — the case that earns the suite is the sibling-prefix trap,
// which fails by producing a plausible-looking wrong answer ("-a/x.txt") rather than by
// throwing.
describe('relOf (how a path is spelt on screen)', () => {
  it('measures a file inside the workspace from its root', () => {
    expect(relOf('/w/ws-a/apps/api/.env', '/w/ws-a')).toBe('apps/api/.env')
  })

  it('leaves a file outside the workspace absolute', () => {
    expect(relOf('/elsewhere/notes.txt', '/w/ws-a')).toBe('/elsewhere/notes.txt')
  })

  it('does not treat a sibling directory as a parent', () => {
    // "/w/ws" is a prefix of "/w/ws-a" as text while being no parent of it
    expect(relOf('/w/ws-a/x.txt', '/w/ws')).toBe('/w/ws-a/x.txt')
  })

  it('answers the path unchanged with no root to measure against', () => {
    expect(relOf('/w/ws-a/x.txt', null)).toBe('/w/ws-a/x.txt')
  })

  it('answers the root itself unchanged — callers lean on this', () => {
    expect(relOf('/w/ws-a', '/w/ws-a')).toBe('/w/ws-a')
  })
})
