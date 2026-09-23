import { describe, it, expect } from 'vitest'

import {
  applyWindowCommand,
  commandTarget,
  guestShortcut,
  nextZoomLevel,
  type CommandTarget,
  type GuestKeyInput,
  type WindowSurface
} from '../../src/shared/shortcutDispatch'
import type { BrowserCommand } from '../../src/shared/types'

const MATRIX: [BrowserCommand, CommandTarget, CommandTarget][] = [
  ['toggle-browser', { to: 'app', cmd: 'toggle-browser' }, { to: 'app', cmd: 'toggle-browser' }],
  [
    'toggle-focus-mode',
    { to: 'app', cmd: 'toggle-focus-mode' },
    { to: 'app', cmd: 'toggle-focus-mode' }
  ],
  [
    'browser-new-tab',
    { to: 'browser', cmd: 'browser-new-tab' },
    { to: 'browser', cmd: 'browser-new-tab' }
  ],
  [
    'browser-close-tab',
    { to: 'browser', cmd: 'browser-close-tab' },
    { to: 'browser', cmd: 'browser-close-tab' }
  ],
  ['browser-focus-address', { to: 'browser', cmd: 'browser-focus-address' }, { to: 'none' }],
  ['browser-back', { to: 'browser', cmd: 'browser-back' }, { to: 'none' }],
  ['browser-forward', { to: 'browser', cmd: 'browser-forward' }, { to: 'none' }],
  ['browser-reload', { to: 'browser', cmd: 'browser-reload' }, { to: 'none' }],
  [
    'browser-devtools',
    { to: 'browser', cmd: 'browser-devtools' },
    { to: 'window', cmd: 'window-devtools' }
  ],
  [
    'browser-zoom-in',
    { to: 'browser', cmd: 'browser-zoom-in' },
    { to: 'window', cmd: 'window-zoom-in' }
  ],
  [
    'browser-zoom-out',
    { to: 'browser', cmd: 'browser-zoom-out' },
    { to: 'window', cmd: 'window-zoom-out' }
  ],
  [
    'browser-zoom-reset',
    { to: 'browser', cmd: 'browser-zoom-reset' },
    { to: 'window', cmd: 'window-zoom-reset' }
  ]
]

describe('shortcut dispatch table (Q2): each command on both surfaces — without the Browser a key keeps its whole-window meaning', () => {
  for (const [cmd, active, inactive] of MATRIX) {
    it(`routes ${cmd} to ${active.to} with the Browser active, ${inactive.to} without`, () => {
      expect(commandTarget(cmd, true)).toEqual(active)
      expect(commandTarget(cmd, false)).toEqual(inactive)
    })
  }

  it('covers every command the menu can send', () => {
    const covered = MATRIX.map(([cmd]) => cmd)
    expect(new Set(covered).size).toBe(covered.length)
    expect(covered).toHaveLength(12)
  })

  it('never routes a reload to the window, on either surface — a renderer reload takes every live terminal with it', () => {
    for (const active of [true, false]) {
      for (const [cmd] of MATRIX) {
        const target = commandTarget(cmd, active)
        if (target.to === 'window') expect(target.cmd).not.toMatch(/reload/)
      }
    }
    expect(commandTarget('browser-reload', false)).toEqual({ to: 'none' })
  })
})

describe("whole-window zoom step: the step and limits of Electron's own zoom roles, which these keys fall back to", () => {
  it('steps by half a level in and out, and resets to zero', () => {
    expect(nextZoomLevel(0, 'window-zoom-in')).toBe(0.5)
    expect(nextZoomLevel(0.5, 'window-zoom-in')).toBe(1)
    expect(nextZoomLevel(0, 'window-zoom-out')).toBe(-0.5)
    expect(nextZoomLevel(2.5, 'window-zoom-reset')).toBe(0)
    expect(nextZoomLevel(-3, 'window-zoom-reset')).toBe(0)
  })

  it('clamps at the ends of the range instead of running away', () => {
    expect(nextZoomLevel(9, 'window-zoom-in')).toBe(9)
    expect(nextZoomLevel(8.75, 'window-zoom-in')).toBe(9)
    expect(nextZoomLevel(-8, 'window-zoom-out')).toBe(-8)
    expect(nextZoomLevel(-7.75, 'window-zoom-out')).toBe(-8)
  })
})

function fakeWindow(level = 0): WindowSurface & { devtools: number; level: number } {
  return {
    devtools: 0,
    level,
    toggleDevTools() {
      this.devtools++
    },
    getZoomLevel() {
      return this.level
    },
    setZoomLevel(next: number) {
      this.level = next
    }
  }
}

describe('whole-window fallback execution', () => {
  it('toggles the window devtools without touching its zoom', () => {
    const win = fakeWindow(1.5)
    applyWindowCommand(win, 'window-devtools')
    expect(win.devtools).toBe(1)
    expect(win.level).toBe(1.5)
  })

  it('zooms the window from its current level and never opens devtools doing it', () => {
    const win = fakeWindow(0)
    applyWindowCommand(win, 'window-zoom-in')
    applyWindowCommand(win, 'window-zoom-in')
    expect(win.level).toBe(1)
    applyWindowCommand(win, 'window-zoom-out')
    expect(win.level).toBe(0.5)
    applyWindowCommand(win, 'window-zoom-reset')
    expect(win.level).toBe(0)
    expect(win.devtools).toBe(0)
  })
})

describe('the keys a focused guest has to hand back — ⌘T has no menu accelerator, and a focused page swallows the rest', () => {
  const key = (k: string, mods: Partial<GuestKeyInput> = {}): GuestKeyInput => ({
    key: k,
    meta: true,
    control: false,
    shift: false,
    alt: false,
    ...mods
  })

  it('carries ⌘T and ⌘L', () => {
    expect(guestShortcut(key('t'))).toBe('browser-new-tab')
    expect(guestShortcut(key('T'))).toBe('browser-new-tab')
    expect(guestShortcut(key('l'))).toBe('browser-focus-address')
  })

  it('carries them on Control where there is no Command key', () => {
    expect(guestShortcut(key('t', { meta: false, control: true }))).toBe('browser-new-tab')
  })

  it('FR-17 carries ⌘W, so a focused page closes its TAB and not the session', () => {
    expect(guestShortcut(key('w'))).toBe('browser-close-tab')
  })

  it('FR-35 carries ⌘F, so in-guest find reaches the panel', () => {
    expect(guestShortcut(key('f'))).toBe('find')
  })

  it('FR-53 carries ⌘⌥←/→ — the one entry that WANTS the option key', () => {
    expect(guestShortcut(key('ArrowRight', { alt: true }))).toBe('cycle-next')
    expect(guestShortcut(key('ArrowLeft', { alt: true }))).toBe('cycle-prev')
  })

  it('leaves a bare, shifted or option-held key to the page', () => {
    expect(guestShortcut(key('t', { meta: false }))).toBeNull()
    expect(guestShortcut(key('t', { shift: true }))).toBeNull()
    expect(guestShortcut(key('l', { alt: true }))).toBeNull()
    expect(guestShortcut(key('ArrowRight', { meta: false, alt: true }))).toBeNull()
    expect(guestShortcut(key('ArrowRight', { alt: true, shift: true }))).toBeNull()
  })

  it('carries nothing else — ⌘R must not double-reload, and the rest are the page’s', () => {
    for (const k of ['r', 'a', '[', ']', '0']) expect(guestShortcut(key(k))).toBeNull()
  })
})
