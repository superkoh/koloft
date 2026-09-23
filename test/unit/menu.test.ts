import fs from 'fs'
import path from 'path'
import { describe, it, expect, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const state: {
    template: unknown[] | null
    live: Map<string, { enabled: boolean; checked: boolean }>
  } = {
    template: null,
    live: new Map()
  }
  return {
    state,
    app: { name: 'Koloft' },
    Menu: {
      buildFromTemplate: (t: unknown[]) => {
        state.template = t
        state.live = new Map()
        type T = { id?: string; enabled?: boolean; checked?: boolean; submenu?: unknown[] }
        const seedLiveItemsAsBuilt = (items: T[]): void => {
          for (const i of items) {
            if (i.id)
              state.live.set(i.id, { enabled: i.enabled !== false, checked: i.checked === true })
            if (i.submenu) seedLiveItemsAsBuilt(i.submenu as T[])
          }
        }
        seedLiveItemsAsBuilt(t as T[])
        return { built: true }
      },
      setApplicationMenu: () => {},
      getApplicationMenu: () => ({
        getMenuItemById: (id: string) => mocks.state.live.get(id) ?? null
      })
    }
  }
})
vi.mock('electron', () => ({ app: mocks.app, Menu: mocks.Menu }))

import {
  setFindAvailable,
  setKeepAwakeChecked,
  setupAppMenu,
  setWorkbenchAvailable
} from '../../src/main/menu'

interface Item {
  id?: string
  label?: string
  role?: string
  accelerator?: string
  type?: string
  click?: () => void
  enabled?: boolean
  checked?: boolean
  submenu?: Item[]
}

function buildMenu(onShortcut: (action: string) => void = () => {}, keepAwake?: boolean): Item[] {
  mocks.state.template = null
  setupAppMenu(onShortcut, () => {}, keepAwake)
  const template = mocks.state.template
  if (!template) throw new Error('setupAppMenu never built a menu')
  return template as Item[]
}

function topLevel(template: Item[], label: string): Item {
  const menu = template.find((m) => m.label === label)
  if (!menu) throw new Error(`no "${label}" menu in the template`)
  return menu
}

function flatten(items: Item[]): Item[] {
  return items.flatMap((i) => [i, ...(i.submenu ? flatten(i.submenu) : [])])
}

function normalizeAccel(accel: string): string {
  return accel
    .toLowerCase()
    .split('+')
    .map((p) => p.trim())
    .filter(Boolean)
    .sort()
    .join('+')
}

describe('app menu: Restart Session', () => {
  it('exposes the item in File with the contracted id, label and ⇧⌘R accelerator', () => {
    const file = topLevel(buildMenu(), 'File').submenu!
    const item = file.find((i) => i.id === 'restart-session')
    expect(item).toBeDefined()
    expect(item!.label).toBe('Restart Session')
    expect(item!.accelerator).toBe('Shift+CmdOrCtrl+R')
  })

  it('forwards the restart-session action to the renderer when clicked', () => {
    const seen: string[] = []
    const file = topLevel(
      buildMenu((a) => seen.push(a)),
      'File'
    ).submenu!
    file.find((i) => i.id === 'restart-session')!.click!()
    expect(seen).toEqual(['restart-session'])
  })

  it('binds ⇧⌘R exactly once across the whole menu', () => {
    const bound = flatten(buildMenu()).filter((i) => i.accelerator === 'Shift+CmdOrCtrl+R')
    expect(bound.map((i) => i.id)).toEqual(['restart-session'])
  })
})

// PLATFORM§7
describe('app menu: New Session', () => {
  it('exposes the item in File with the contracted id, label and ⌘N accelerator', () => {
    const file = topLevel(buildMenu(), 'File').submenu!
    const item = file.find((i) => i.id === 'new-session')
    expect(item).toBeDefined()
    expect(item!.label).toBe('New Session…')
    expect(item!.accelerator).toBe('CmdOrCtrl+N')
  })

  it('forwards the new-session action to the renderer when clicked', () => {
    const seen: string[] = []
    const file = topLevel(
      buildMenu((a) => seen.push(a)),
      'File'
    ).submenu!
    file.find((i) => i.id === 'new-session')!.click!()
    expect(seen).toEqual(['new-session'])
  })

  it('binds ⌘N exactly once across the whole menu', () => {
    const bound = flatten(buildMenu()).filter((i) => i.accelerator === 'CmdOrCtrl+N')
    expect(bound.map((i) => i.id)).toEqual(['new-session'])
  })
})

describe('app menu: New Worktree Session', () => {
  it('exposes the item in File with the contracted id, label and ⇧⌘N accelerator', () => {
    const file = topLevel(buildMenu(), 'File').submenu!
    const item = file.find((i) => i.id === 'new-worktree-session')
    expect(item).toBeDefined()
    expect(item!.label).toBe('New Worktree Session…')
    expect(item!.accelerator).toBe('Shift+CmdOrCtrl+N')
  })

  it('forwards the new-worktree-session action to the renderer when clicked', () => {
    const seen: string[] = []
    const file = topLevel(
      buildMenu((a) => seen.push(a)),
      'File'
    ).submenu!
    file.find((i) => i.id === 'new-worktree-session')!.click!()
    expect(seen).toEqual(['new-worktree-session'])
  })

  it('binds ⇧⌘N exactly once across the whole menu', () => {
    const bound = flatten(buildMenu()).filter(
      (i) => i.accelerator && normalizeAccel(i.accelerator) === normalizeAccel('Shift+CmdOrCtrl+N')
    )
    expect(bound.map((i) => i.id)).toEqual(['new-worktree-session'])
  })
})

describe('app menu: the retired New Tab / ⌘T', () => {
  it('offers no New Tab item anywhere', () => {
    const all = flatten(buildMenu())
    expect(all.some((i) => /new\s*tab/i.test(i.label ?? ''))).toBe(false)
  })

  it('binds ⌘T nowhere, leaving the key to the renderer', () => {
    const bound = flatten(buildMenu()).filter(
      (i) => i.accelerator && normalizeAccel(i.accelerator) === 'cmdorctrl+t'
    )
    expect(bound.map((i) => i.label ?? i.role)).toEqual([])
  })
})

// PLATFORM§7
describe('app menu: New Terminal Tab', () => {
  it('exposes the item in View with the contracted id, label and ⌃` accelerator', () => {
    const view = topLevel(buildMenu(), 'View').submenu!
    const item = view.find((i) => i.id === 'new-terminal-tab')
    expect(item).toBeDefined()
    expect(item!.label).toBe('New Terminal Tab')
    expect(item!.accelerator).toBe('Control+`')
  })

  it('forwards the new-terminal-tab action to the renderer when clicked', () => {
    const seen: string[] = []
    const view = topLevel(
      buildMenu((a) => seen.push(a)),
      'View'
    ).submenu!
    view.find((i) => i.id === 'new-terminal-tab')!.click!()
    expect(seen).toEqual(['new-terminal-tab'])
  })

  it('binds ⌃` exactly once across the whole menu', () => {
    const bound = flatten(buildMenu()).filter(
      (i) => i.accelerator && normalizeAccel(i.accelerator) === '`+control'
    )
    expect(bound.map((i) => i.id)).toEqual(['new-terminal-tab'])
  })

  it('ships disabled, exactly as Focus Mode does, rather than a live key that does nothing', () => {
    const view = topLevel(buildMenu(), 'View').submenu!
    expect(view.find((i) => i.id === 'new-terminal-tab')!.enabled).toBe(false)
    expect(view.find((i) => i.id === 'toggle-focus-mode')!.enabled).toBe(false)
  })

  it('flips both items on the renderer’s report, each on its own flag: a cold session keeps Focus Mode but not the shell', () => {
    const enabled = (id: string): boolean | undefined => mocks.state.live.get(id)?.enabled

    buildMenu()
    setWorkbenchAvailable(true, true)
    expect(enabled('toggle-focus-mode')).toBe(true)
    expect(enabled('new-terminal-tab')).toBe(true)

    setWorkbenchAvailable(true, false)
    expect(enabled('toggle-focus-mode')).toBe(true)
    expect(enabled('new-terminal-tab')).toBe(false)

    setWorkbenchAvailable(false, false)
    expect(enabled('toggle-focus-mode')).toBe(false)
    expect(enabled('new-terminal-tab')).toBe(false)
  })
})

// PLATFORM§7
describe('app menu: Notes', () => {
  it('exposes the item in View with the contracted id, label and ⌥⌘N accelerator', () => {
    const view = topLevel(buildMenu(), 'View').submenu!
    const item = view.find((i) => i.id === 'focus-notes')
    expect(item).toBeDefined()
    expect(item!.label).toBe('Notes')
    expect(item!.accelerator).toBe('Alt+CmdOrCtrl+N')
    expect(item!.enabled).not.toBe(false)
  })

  it('forwards the focus-notes action to the renderer when clicked', () => {
    const seen: string[] = []
    const view = topLevel(
      buildMenu((a) => seen.push(a)),
      'View'
    ).submenu!
    view.find((i) => i.id === 'focus-notes')!.click!()
    expect(seen).toEqual(['focus-notes'])
  })

  it('binds ⌥⌘N exactly once across the whole menu', () => {
    const bound = flatten(buildMenu()).filter(
      (i) => i.accelerator && normalizeAccel(i.accelerator) === normalizeAccel('Alt+CmdOrCtrl+N')
    )
    expect(bound.map((i) => i.id)).toEqual(['focus-notes'])
  })
})

// PLATFORM§7
describe('app menu: View menu after Force Reload gave up ⇧⌘R', () => {
  it('no longer offers Force Reload anywhere', () => {
    const all = flatten(buildMenu())
    expect(all.some((i) => i.role === 'forceReload')).toBe(false)
    expect(all.some((i) => /force\s*reload/i.test(i.label ?? ''))).toBe(false)
  })

  // PLATFORM§7
  it('keeps Reload on ⌘R as a custom item, never the role that reloads the whole app, plus the other standard View items', () => {
    const view = topLevel(buildMenu(), 'View').submenu!
    const reload = view.find((i) => i.id === 'browser-reload')
    expect(reload).toBeDefined()
    expect(reload!.accelerator).toBe('CmdOrCtrl+R')
    expect(view.some((i) => i.role === 'reload')).toBe(false)
    const labelled = view.map((i) => i.label).filter(Boolean)
    expect(labelled).toEqual(
      expect.arrayContaining(['Toggle Developer Tools', 'Actual Size', 'Zoom In', 'Zoom Out'])
    )
    expect(view.some((i) => i.role === 'togglefullscreen')).toBe(true)
  })
})

describe('app menu: the whole-window keys stay real, always-enabled items after the roles went away', () => {
  const isMac = process.platform === 'darwin'
  const standard: [string, string][] = [
    ['browser-devtools', isMac ? 'Alt+Command+I' : 'Ctrl+Shift+I'],
    ['browser-zoom-reset', 'CmdOrCtrl+0'],
    ['browser-zoom-in', 'CmdOrCtrl+Plus'],
    ['browser-zoom-out', 'CmdOrCtrl+-']
  ]

  for (const [id, accelerator] of standard) {
    it(`keeps ${id} enabled on ${accelerator}, bound exactly once`, () => {
      const all = flatten(buildMenu())
      const item = all.find((i) => i.id === id)
      expect(item, `no menu item with id "${id}"`).toBeDefined()
      expect(item!.accelerator).toBe(accelerator)
      expect((item as { enabled?: boolean }).enabled).not.toBe(false)
      const bound = all.filter(
        (i) => i.accelerator && normalizeAccel(i.accelerator) === normalizeAccel(accelerator)
      )
      expect(bound.map((i) => i.id)).toEqual([id])
    })
  }
})

describe('app menu: the Browser commands, all forwarded to the renderer', () => {
  const ids = [
    'toggle-browser',
    'browser-new-tab',
    'browser-close-tab',
    'browser-focus-address',
    'browser-back',
    'browser-forward',
    'browser-reload',
    'browser-zoom-in',
    'browser-zoom-out',
    'browser-zoom-reset',
    'browser-devtools',
    'toggle-focus-mode'
  ]

  function buildWithCommands(seen: string[]): Item[] {
    mocks.state.template = null
    setupAppMenu(
      () => {},
      (cmd) => seen.push(cmd)
    )
    const template = mocks.state.template
    if (!template) throw new Error('setupAppMenu never built a menu')
    return template as Item[]
  }

  it('exposes every command id and forwards it verbatim when clicked', () => {
    const seen: string[] = []
    const all = flatten(buildWithCommands(seen))
    for (const id of ids) {
      const item = all.find((i) => i.id === id)
      expect(item, `no menu item with id "${id}"`).toBeDefined()
      item!.click!()
    }
    expect(seen).toEqual(ids)
  })

  it('leaves ⌘T unbound and offers no plain New Tab item', () => {
    const all = flatten(buildMenu())
    expect(all.some((i) => /new\s*tab/i.test(i.label ?? ''))).toBe(false)
    expect(
      all.filter((i) => i.accelerator && normalizeAccel(i.accelerator) === 'cmdorctrl+t')
    ).toEqual([])
  })

  it('binds ⌘F to Find (id find-in-page) and nothing else', () => {
    const bound = flatten(buildMenu()).filter(
      (i) => i.accelerator && normalizeAccel(i.accelerator) === 'cmdorctrl+f'
    )
    expect(bound.map((i) => i.id)).toEqual(['find-in-page'])
  })
})

describe.runIf(process.platform === 'darwin')('app menu: Keep Mac Awake (keepAwake)', () => {
  it('exposes a checkbox in View built to the setting handed in', () => {
    const on = topLevel(
      buildMenu(() => {}, true),
      'View'
    ).submenu!.find((i) => i.id === 'keep-awake')
    expect(on).toBeDefined()
    expect(on!.label).toBe('Keep Mac Awake')
    expect(on!.type).toBe('checkbox')
    expect(on!.checked).toBe(true)
    expect(on!.accelerator).toBeUndefined()
    const off = topLevel(
      buildMenu(() => {}, false),
      'View'
    ).submenu!.find((i) => i.id === 'keep-awake')
    expect(off!.checked).toBe(false)
  })

  it('reports toggle-keep-awake when clicked', () => {
    const seen: string[] = []
    topLevel(
      buildMenu((a) => seen.push(a), true),
      'View'
    ).submenu!.find((i) => i.id === 'keep-awake')!.click!()
    expect(seen).toEqual(['toggle-keep-awake'])
  })

  it('follows the setting through setKeepAwakeChecked', () => {
    buildMenu(() => {}, true)
    setKeepAwakeChecked(false)
    expect(mocks.state.live.get('keep-awake')?.checked).toBe(false)
    setKeepAwakeChecked(true)
    expect(mocks.state.live.get('keep-awake')?.checked).toBe(true)
  })
})

describe.runIf(process.platform === 'darwin')('app menu: Settings… (⌘,)', () => {
  it('exposes the item in the app menu on ⌘,, bound exactly once', () => {
    const all = flatten(buildMenu())
    const item = all.find((i) => i.id === 'open-settings')
    expect(item).toBeDefined()
    expect(item!.label).toBe('Settings…')
    expect(item!.accelerator).toBe('CmdOrCtrl+,')
    const bound = all.filter(
      (i) => i.accelerator && normalizeAccel(i.accelerator) === normalizeAccel('CmdOrCtrl+,')
    )
    expect(bound.map((i) => i.id)).toEqual(['open-settings'])
  })

  it('forwards the open-settings action to the renderer when clicked', () => {
    const seen: string[] = []
    flatten(buildMenu((a) => seen.push(a))).find((i) => i.id === 'open-settings')!.click!()
    expect(seen).toEqual(['open-settings'])
  })
})

describe('app menu: ⌘W belongs to Close Tab alone', () => {
  it('binds ⌘W exactly once, to Close Tab, and builds no role-made File or Window menu that would bind it again', () => {
    const all = flatten(buildMenu())
    const bound = all.filter(
      (i) => i.accelerator && normalizeAccel(i.accelerator) === 'cmdorctrl+w'
    )
    expect(bound.map((i) => i.label)).toEqual(['Close Tab'])
    expect(all.some((i) => i.role === 'fileMenu' || i.role === 'windowMenu')).toBe(false)
  })

  it.runIf(process.platform === 'darwin')(
    'moves Close Window to an explicit ⇧⌘W, since the close role would otherwise take ⌘W',
    () => {
      const closers = flatten(buildMenu()).filter((i) => i.role === 'close')
      expect(closers).toHaveLength(1)
      expect(closers[0].label).toBe('Close Window')
      expect(closers[0].accelerator).toBe('Shift+CmdOrCtrl+W')
    }
  )
})

describe('app menu: only the four gated items ever grey out', () => {
  it('keeps Toggle Workbench and Search Files enabled, so a greyed item never reads as a build with no Workbench; only Focus Mode, New Terminal Tab, Save and Find grey out', () => {
    buildMenu()
    setWorkbenchAvailable(false, false)
    setFindAvailable(false)
    const greyed = [...mocks.state.live]
      .filter(([, item]) => !item.enabled)
      .map(([id]) => id)
      .sort()
    expect(greyed).toEqual(['find-in-page', 'new-terminal-tab', 'save', 'toggle-focus-mode'])
  })
})

const MODIFIER_GLYPHS: Record<string, string> = {
  cmdorctrl: '⌘',
  command: '⌘',
  shift: '⇧',
  alt: '⌥',
  control: '⌃'
}
const KEY_GLYPHS: Record<string, string> = { return: '⏎', plus: '+' }
const MODIFIER_ORDER = '⌃⌥⇧⌘'

function canonicalKey(modifiers: string[], key: string): string {
  const mods = [...modifiers].sort((a, b) => MODIFIER_ORDER.indexOf(a) - MODIFIER_ORDER.indexOf(b))
  return mods.join('') + key.toUpperCase()
}

function fromAccelerator(accel: string): string {
  const parts = accel.split('+')
  const key = parts.pop()!
  return canonicalKey(
    parts.map((p) => MODIFIER_GLYPHS[p.toLowerCase()] ?? p),
    KEY_GLYPHS[key.toLowerCase()] ?? key
  )
}

function splitPaneKey(key: string): { mods: string[]; key: string } {
  const chars = [...key]
  const mods: string[] = []
  while (chars.length > 1 && MODIFIER_ORDER.includes(chars[0])) mods.push(chars.shift()!)
  return { mods, key: chars.join('') }
}

const RENDERER_SRC = path.join(__dirname, '..', '..', 'src', 'renderer', 'src')

function shortcutsPaneKeys(): string[] {
  const src = fs.readFileSync(
    path.join(RENDERER_SRC, 'components', 'settings', 'ShortcutsPane.tsx'),
    'utf8'
  )
  return [...src.matchAll(/keys:\s*\[((?:\s*'[^']*',?)*)\s*\]/g)].flatMap((list) =>
    [...list[1].matchAll(/'([^']*)'/g)].map((m) => m[1])
  )
}

const DOM_KEY_GLYPHS: Record<string, string> = {
  ArrowLeft: '←',
  ArrowRight: '→',
  ArrowUp: '↑',
  ArrowDown: '↓',
  Escape: 'ESC',
  Enter: '⏎'
}

function appHandledKeys(): string[] {
  const src = fs.readFileSync(path.join(RENDERER_SRC, 'App.tsx'), 'utf8')
  const keys = [...src.matchAll(/\be\.key\s*[!=]==\s*'([^']+)'/g)].map((m) => m[1])
  return [...new Set(keys.map((k) => DOM_KEY_GLYPHS[k] ?? k.toUpperCase()))].sort()
}

describe.runIf(process.platform === 'darwin')(
  'Settings ▸ Shortcuts lists every real binding',
  () => {
    it('lists every accelerator the native menu binds, so the pane cannot drift from the menu', () => {
      const listed = new Set(
        shortcutsPaneKeys().map((k) => {
          const { mods, key } = splitPaneKey(k)
          return canonicalKey(mods, key)
        })
      )
      const unlisted = flatten(buildMenu())
        .filter((i) => i.accelerator)
        .map((i) => ({ item: i.label ?? i.role, key: fromAccelerator(i.accelerator!) }))
        .filter((b) => !listed.has(b.key))
      expect(unlisted).toEqual([])
    })

    it('lists every key App.tsx handles itself, so the pane cannot drift from the renderer', () => {
      const listedKeys = new Set(shortcutsPaneKeys().map((k) => splitPaneKey(k).key.toUpperCase()))
      const handled = appHandledKeys()
      expect(handled.length).toBeGreaterThan(0)
      expect(handled.filter((k) => !listedKeys.has(k))).toEqual([])
    })
  }
)
