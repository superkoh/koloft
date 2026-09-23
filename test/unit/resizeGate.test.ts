import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  beginLayoutDrag,
  endLayoutDrag,
  isLayoutDragging,
  onLayoutDragEnd
} from '../../src/renderer/src/resizeGate'

// The gate decides whether a terminal is allowed to push a new size to its pty. Its
// two failure modes are both silent in the UI: a gate that never releases freezes
// every terminal at its pre-drag size forever, and one that announces a release
// nobody asked for costs a spurious SIGWINCH. Neither is localisable from the e2e
// drag spec, which can only see "the terminal did / didn't resize".

beforeEach(() => {
  endLayoutDrag() // module singleton — never let one test's drag leak into the next
})

describe('resizeGate', () => {
  it('is idle until a drag starts, and idle again once it ends', () => {
    expect(isLayoutDragging()).toBe(false)
    beginLayoutDrag()
    expect(isLayoutDragging()).toBe(true)
    endLayoutDrag()
    expect(isLayoutDragging()).toBe(false)
  })

  it('notifies every subscriber exactly once when a drag ends', () => {
    const a = vi.fn()
    const b = vi.fn()
    onLayoutDragEnd(a)
    onLayoutDragEnd(b)
    beginLayoutDrag()
    expect(a).not.toHaveBeenCalled()
    endLayoutDrag()
    expect(a).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenCalledTimes(1)
  })

  it('stays silent when nothing was being dragged', () => {
    const fn = vi.fn()
    onLayoutDragEnd(fn)
    endLayoutDrag()
    expect(fn).not.toHaveBeenCalled()
  })

  it('collapses a re-entered drag into one release', () => {
    const fn = vi.fn()
    onLayoutDragEnd(fn)
    beginLayoutDrag()
    beginLayoutDrag()
    endLayoutDrag()
    expect(fn).toHaveBeenCalledTimes(1)
    expect(isLayoutDragging()).toBe(false)
    endLayoutDrag()
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('stops notifying an unsubscribed listener', () => {
    const fn = vi.fn()
    const off = onLayoutDragEnd(fn)
    off()
    beginLayoutDrag()
    endLayoutDrag()
    expect(fn).not.toHaveBeenCalled()
  })
})
