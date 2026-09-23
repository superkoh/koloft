import { describe, it, expect, vi } from 'vitest'

// The app menu is the only surface the restart feature has: ⇧⌘R and the File item are
// the same code path, and the e2e suite triggers it by menu-item id. Electron can't run
// under plain-node vitest, so stub it and capture the template handed to buildFromTemplate
// — that template IS what becomes the menu.
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
        // The built menu the setters reach for. Electron flattens the template into
        // MenuItems and looks them up by id; the only properties any setter here touches
        // are `enabled` and `checked`, so an id → { enabled, checked } map is the whole
        // of what has to be real — seeded from the template so a built-disabled item
        // starts disabled and a checkbox starts as built.
        state.live = new Map()
        type T = { id?: string; enabled?: boolean; checked?: boolean; submenu?: unknown[] }
        const walk = (items: T[]): void => {
          for (const i of items) {
            if (i.id)
              state.live.set(i.id, { enabled: i.enabled !== false, checked: i.checked === true })
            if (i.submenu) walk(i.submenu as T[])
          }
        }
        walk(t as T[])
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

import { setKeepAwakeChecked, setupAppMenu, setWorkbenchAvailable } from '../../src/main/menu'

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

/** every item in the tree, submenus included */
function flatten(items: Item[]): Item[] {
  return items.flatMap((i) => [i, ...(i.submenu ? flatten(i.submenu) : [])])
}

/** modifier order in an accelerator is a free choice; the keys it binds are not */
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

// ⌘N is the only entry point for a Claude session (agent-centric A1/§5: ⌘T retired).
// xterm swallows plain renderer keydowns, so it has to be a native accelerator; the
// e2e suite triggers it by the menu-item id, which is therefore a contract.
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

// ⇧⌘N is the second creation gesture (new-session-entrances D8) — "shift = the same
// action, one family over", the way Finder and the browsers use it. Same native-accelerator
// reason as ⌘N, same id-as-contract for the e2e suite; the assertions are per-key by hand,
// so a new key is only covered once it has its own.
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

// Free-terminal retirement (agent-centric §9): there is no global New Tab any more, and
// ⌘T must reach the renderer as a plain keydown so a focused panel surface can claim it
// (§7). A menu accelerator is handled natively and would swallow the key app-wide, so the
// binding's ABSENCE is the contract here — not just the item's.
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

// D3/R5: ⌃` opens one terminal tab in the selected session's panel. The accelerator
// has to be native — xterm holds the focus most of the time and swallows plain renderer
// keydowns (A1) — so the menu item IS the feature's only wiring, and its id is what the
// e2e suite triggers by. (It used to be `toggle-terminal`, the global island's three-state
// toggle; the id, the label and the enabled flag all moved with the feature.)
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

  // R5/D1: a shell has nowhere to live until a session is selected, bound and alive, and
  // only the renderer knows that. Built disabled, exactly as Focus Mode is — a live
  // accelerator that silently does nothing is a worse answer than a greyed item.
  it('ships disabled, exactly as Focus Mode does', () => {
    const view = topLevel(buildMenu(), 'View').submenu!
    expect(view.find((i) => i.id === 'new-terminal-tab')!.enabled).toBe(false)
    expect(view.find((i) => i.id === 'toggle-focus-mode')!.enabled).toBe(false)
  })

  // …and the flip itself, which is the half the built template cannot show. The two items
  // take SEPARATE flags because they ask different questions: Focus Mode only needs a
  // panel to give the row to, so a cold session still counts, while a shell needs a claude
  // that is alive to belong to (D2). The mixed case is the one that would pass on a build
  // that wired both to one flag — which is what this used to do.
  it('flips both items on the renderer’s report, each on its own flag', () => {
    const enabled = (id: string): boolean | undefined => mocks.state.live.get(id)?.enabled

    buildMenu()
    setWorkbenchAvailable(true, true)
    expect(enabled('toggle-focus-mode')).toBe(true)
    expect(enabled('new-terminal-tab')).toBe(true)

    // a selected COLD session: its panel is still readable, its shells are gone (D2)
    setWorkbenchAvailable(true, false)
    expect(enabled('toggle-focus-mode')).toBe(true)
    expect(enabled('new-terminal-tab')).toBe(false)

    // nothing selected at all: neither has anything to act on (FR-04 / D1)
    setWorkbenchAvailable(false, false)
    expect(enabled('toggle-focus-mode')).toBe(false)
    expect(enabled('new-terminal-tab')).toBe(false)
  })
})

// ⌥⌘N puts the caret in the workspace's note. Native accelerator for the usual
// reason — xterm eats plain renderer keydowns — so the menu item IS the shortcut's whole
// wiring, and its id is the contract the e2e suite triggers by. Unlike the two items
// above it is always enabled: with no workspace pinned the renderer simply does nothing.
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

// ⇧⌘R is Electron's default Force Reload accelerator, so the View menu can no longer be
// the `viewMenu` role — but rebuilding it by hand must not quietly cost the user the rest
// of the standard View menu (or Reload's own ⌘R).
describe('app menu: View menu after Force Reload gave up ⇧⌘R', () => {
  it('no longer offers Force Reload anywhere', () => {
    const all = flatten(buildMenu())
    expect(all.some((i) => i.role === 'forceReload')).toBe(false)
    expect(all.some((i) => /force\s*reload/i.test(i.label ?? ''))).toBe(false)
  })

  // session-browser D9/IMPL-4/5 overturns the mechanism these items used to have: an
  // Electron role acts on the whole Koloft renderer, so ⌘R pressed inside a guest would
  // reload the app and take every terminal with it. The items — and ⌘R itself — must
  // still be there; they are custom, renderer-dispatched ones now.
  it('keeps Reload on ⌘R, plus the other standard View items', () => {
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

// Q2's else-branch: dropping the roles must not cost the app the keys themselves. With
// another surface on the aux column, DevTools and the three zoom items keep their
// whole-window meaning, so they stay real, always-enabled items on the accelerators the
// roles bound — the renderer decides where each one lands, never the menu.
describe('app menu: the whole-window keys after the roles went away (Q2)', () => {
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
      // an item the user cannot reach outside the Browser would be the regression
      expect((item as { enabled?: boolean }).enabled).not.toBe(false)
      const bound = all.filter(
        (i) => i.accelerator && normalizeAccel(i.accelerator) === normalizeAccel(accelerator)
      )
      expect(bound.map((i) => i.id)).toEqual([id])
    })
  }
})

// D9/IMPL-4: every Browser command reaches the renderer, because only the renderer knows
// which aux surface is active. The ids are what the e2e suite triggers by, so they are a
// contract; ⌘T's ABSENCE from the menu is one too (it travels the guest's
// before-input-event hook instead, §08 P1⑩).
describe('app menu: the Browser commands (D9)', () => {
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

// keepAwake: the View checkbox is the menu-side half of the quick switch (the titlebar
// coffee button is the other). It is a CHECKBOX because it mirrors a setting rather than
// firing a gesture, and it is main that flips the setting — the click reaches index.ts
// as 'toggle-keep-awake', never the renderer. macOS only: caffeinate exists nowhere else.
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
