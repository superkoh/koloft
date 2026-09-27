import { describe, it, expect } from 'vitest'
import {
  buildResetPatch,
  sanitizeSettingsPatch,
  clampFontSize,
  sanitizeWorkbenchWidth,
  WORKBENCH_WIDTH_FLOOR,
  sanitizeNotesHeight,
  NOTES_HEIGHT_FLOOR,
  sanitizeLoadedSettings
} from '@shared/settingsOps'
import { DEFAULT_SETTINGS, HINT_IDS } from '@shared/types'

describe('buildResetPatch (FR-12)', () => {
  it('excludes the whole account domain: accounts, multiAccount, skipPermissions, fablePriority', () => {
    const patch = buildResetPatch()
    expect(patch).not.toHaveProperty('accounts')
    expect(patch).not.toHaveProperty('multiAccount')
    expect(patch).not.toHaveProperty('skipPermissions')
    expect(patch).not.toHaveProperty('fablePriority')
  })

  it('carries every non-account default — browser control, keep-awake, the Notes size and the first-run welcome and tips included', () => {
    const patch = buildResetPatch()
    expect(Object.keys(patch).sort()).toEqual(
      [
        'agentTools',
        'browserControl',
        'browserPaneWidth',
        'dockBadge',
        'filePaneWidth',
        'fileTreeHeight',
        'fontFamily',
        'fontSize',
        'gitAutoFetch',
        'hintsOff',
        'hintsSeen',
        'keepAwake',
        'lastSeenVersion',
        'onboardingSeen',
        'notesFolded',
        'notesHeight',
        'notifyApproval',
        'notifyApprovalSound',
        'notifyExited',
        'notifyTurnDone',
        'showUsage',
        'sidebarWidth',
        'statuslineBuiltin',
        'workbenchWidth',
        'worldClocks'
      ].sort()
    )
    expect(patch.fontSize).toBe(DEFAULT_SETTINGS.fontSize)
    expect(patch.statuslineBuiltin).toBe(DEFAULT_SETTINGS.statuslineBuiltin)
    expect(patch.sidebarWidth).toBe(DEFAULT_SETTINGS.sidebarWidth)
  })
})

describe('sanitizeSettingsPatch (FR-13)', () => {
  it('strips accounts but lets multiAccount/skipPermissions through (legal toggle payloads)', () => {
    const patch = {
      accounts: [{ name: 'x', kind: 'oauth', enabled: true }],
      multiAccount: false,
      skipPermissions: false,
      fontSize: 20
    } as never
    expect(sanitizeSettingsPatch(patch)).toEqual({
      multiAccount: false,
      skipPermissions: false,
      fontSize: 20
    })
  })

  it('lets the git auto-fetch switch through untouched (no whitelist to extend)', () => {
    expect(sanitizeSettingsPatch({ gitAutoFetch: false })).toEqual({ gitAutoFetch: false })
  })

  it('returns an accounts-free patch unchanged and never mutates its input', () => {
    const patch = { fontFamily: 'Menlo', dockBadge: false, accounts: [] } as never
    const out = sanitizeSettingsPatch(patch)
    expect(out).toEqual({ fontFamily: 'Menlo', dockBadge: false })
    expect(patch).toHaveProperty('accounts')
  })
})

describe("sanitizeWorkbenchWidth (FR-08/NFR-07, the disk boundary; below the floor a `web` tab hits most sites' mobile breakpoint)", () => {
  it('keeps a plausible saved width', () => {
    expect(sanitizeWorkbenchWidth(620)).toBe(620)
    expect(sanitizeWorkbenchWidth(WORKBENCH_WIDTH_FLOOR)).toBe(WORKBENCH_WIDTH_FLOOR)
  })

  it('replaces a missing / non-numeric / non-finite value with the default', () => {
    for (const bad of [undefined, null, 'wide', NaN, Infinity, {}, []]) {
      expect(sanitizeWorkbenchWidth(bad)).toBe(DEFAULT_SETTINGS.workbenchWidth)
    }
  })

  it('raises anything below the floor to it, zero and negatives included', () => {
    expect(sanitizeWorkbenchWidth(200)).toBe(WORKBENCH_WIDTH_FLOOR)
    expect(sanitizeWorkbenchWidth(0)).toBe(WORKBENCH_WIDTH_FLOOR)
    expect(sanitizeWorkbenchWidth(-620)).toBe(WORKBENCH_WIDTH_FLOOR)
  })

  it('the shipped default is itself at or above the floor', () => {
    expect(DEFAULT_SETTINGS.workbenchWidth).toBeGreaterThanOrEqual(WORKBENCH_WIDTH_FLOOR)
  })

  it('a saved width narrower than the retired pane widths survives a relaunch: once the key is on disk it wins over them', () => {
    const loaded = sanitizeLoadedSettings({
      workbenchWidth: 480,
      filePaneWidth: 560,
      browserPaneWidth: 700
    })
    expect(loaded.workbenchWidth).toBe(480)
  })
})

describe('sanitizeNotesHeight', () => {
  it('keeps a plausible saved height', () => {
    expect(sanitizeNotesHeight(320)).toBe(320)
    expect(sanitizeNotesHeight(NOTES_HEIGHT_FLOOR)).toBe(NOTES_HEIGHT_FLOOR)
  })

  it('replaces a missing / non-numeric / non-finite value with the default', () => {
    for (const bad of [undefined, null, 'tall', NaN, Infinity, {}, []]) {
      expect(sanitizeNotesHeight(bad)).toBe(DEFAULT_SETTINGS.notesHeight)
    }
  })

  it('raises anything below the floor to it, zero and negatives included', () => {
    expect(sanitizeNotesHeight(40)).toBe(NOTES_HEIGHT_FLOOR)
    expect(sanitizeNotesHeight(0)).toBe(NOTES_HEIGHT_FLOOR)
    expect(sanitizeNotesHeight(-320)).toBe(NOTES_HEIGHT_FLOOR)
  })

  it('the shipped default is itself at or above the floor', () => {
    expect(DEFAULT_SETTINGS.notesHeight).toBeGreaterThanOrEqual(NOTES_HEIGHT_FLOOR)
  })
})

describe('sanitizeLoadedSettings and the Notes keys: a hand-edited settings.json is repaired on load, where every reader goes through', () => {
  it('repairs a hand-edited notesHeight and keeps a plausible one', () => {
    expect(sanitizeLoadedSettings({ notesHeight: 0 }).notesHeight).toBe(NOTES_HEIGHT_FLOOR)
    expect(sanitizeLoadedSettings({ notesHeight: 'tall' }).notesHeight).toBe(
      DEFAULT_SETTINGS.notesHeight
    )
    expect(sanitizeLoadedSettings({ notesHeight: 320 }).notesHeight).toBe(320)
  })

  it('forces notesFolded to a real boolean, keeping one that already is', () => {
    expect(sanitizeLoadedSettings({ notesFolded: 'yes' }).notesFolded).toBe(
      DEFAULT_SETTINGS.notesFolded
    )
    expect(sanitizeLoadedSettings({ notesFolded: true }).notesFolded).toBe(true)
    expect(sanitizeLoadedSettings({ notesFolded: false }).notesFolded).toBe(false)
  })

  it('leaves the Notes keys at their defaults when the file says nothing', () => {
    const loaded = sanitizeLoadedSettings({})
    expect(loaded.notesHeight).toBe(DEFAULT_SETTINGS.notesHeight)
    expect(loaded.notesFolded).toBe(DEFAULT_SETTINGS.notesFolded)
  })
})

describe('U-OB-03: sanitizeLoadedSettings and the onboarding keys', () => {
  it('treats a document without onboardingSeen as an upgrade: welcome and tips seen', () => {
    const loaded = sanitizeLoadedSettings({ fontSize: 14 })
    expect(loaded.onboardingSeen).toBe(true)
    expect(loaded.hintsSeen).toEqual([...HINT_IDS])
  })

  it('keeps the first-run defaults for an empty document', () => {
    const loaded = sanitizeLoadedSettings({})
    expect(loaded.onboardingSeen).toBe(false)
    expect(loaded.hintsSeen).toEqual([])
  })

  it('leaves an explicit onboardingSeen: false alone — a first run that already saved once', () => {
    const loaded = sanitizeLoadedSettings({ fontSize: 14, onboardingSeen: false })
    expect(loaded.onboardingSeen).toBe(false)
    expect(loaded.hintsSeen).toEqual([])
  })
})

describe('sanitizeLoadedSettings and the account list', () => {
  it('merges accounts that differ only in letter case within one kind, keeping the first, and keeps the same name under another kind', () => {
    const base = { enabled: true, fable: 'unknown', status: 'ok', addedAt: 1 }
    const accounts = sanitizeLoadedSettings({
      accounts: [
        { ...base, name: 'Work', kind: 'oauth' },
        { ...base, name: 'work', kind: 'oauth' },
        { ...base, name: 'WORK', kind: 'apikey' }
      ]
    }).accounts
    expect(accounts.map((a) => `${a.kind}:${a.name}`)).toEqual(['oauth:Work', 'apikey:WORK'])
  })
})

describe('clampFontSize (FR-08 edge case)', () => {
  it('passes in-range values through', () => {
    expect(clampFontSize('13')).toBe(13)
    expect(clampFontSize('8')).toBe(8)
    expect(clampFontSize('32')).toBe(32)
  })

  it('clamps typed out-of-range values (input min/max does not)', () => {
    expect(clampFontSize('7')).toBe(8)
    expect(clampFontSize('33')).toBe(32)
    expect(clampFontSize('99')).toBe(32)
    expect(clampFontSize('-5')).toBe(8)
  })

  it('falls back to the factory default for empty/invalid input (existing behavior kept)', () => {
    expect(clampFontSize('')).toBe(DEFAULT_SETTINGS.fontSize)
    expect(clampFontSize('abc')).toBe(DEFAULT_SETTINGS.fontSize)
    expect(clampFontSize('0')).toBe(DEFAULT_SETTINGS.fontSize)
  })
})

describe('sanitizeLoadedSettings and worldClocks', () => {
  it('keeps only ids Intl accepts, once each, and caps the list', () => {
    expect(sanitizeLoadedSettings({ worldClocks: 'Europe/London' }).worldClocks).toEqual([])
    expect(
      sanitizeLoadedSettings({ worldClocks: ['Asia/Tokyo', 7, null, 'Foo/Bar', 'Asia/Tokyo'] })
        .worldClocks
    ).toEqual(['Asia/Tokyo'])
    expect(
      sanitizeLoadedSettings({
        worldClocks: ['Europe/London', 'Europe/Berlin', 'Asia/Tokyo', 'Asia/Dubai']
      }).worldClocks
    ).toHaveLength(3)
  })

  it('repairs a hintsSeen that is not a list — every reader appends to it', () => {
    expect(
      sanitizeLoadedSettings({ onboardingSeen: true, hintsSeen: 'workbench' }).hintsSeen
    ).toEqual([])
  })
})

describe('session methods', () => {
  it('loads old settings with Claude as default and both methods enabled', () => {
    expect(sanitizeLoadedSettings({}).sessionMethods).toEqual({
      defaultBackend: 'claude',
      enabled: { claude: true, codex: true }
    })
    expect(buildResetPatch()).not.toHaveProperty('sessionMethods')
  })
  it('keeps Claude enabled and replaces a disabled or unknown default', () => {
    for (const raw of [
      null,
      'codex',
      { defaultBackend: 'unknown' },
      { defaultBackend: 'codex', enabled: { claude: false, codex: false } }
    ]) {
      const methods = sanitizeLoadedSettings({ sessionMethods: raw }).sessionMethods
      expect(methods.defaultBackend).toBe('claude')
      expect(methods.enabled.claude).toBe(true)
    }
    expect(
      sanitizeLoadedSettings({
        sessionMethods: { defaultBackend: 'codex', enabled: { codex: true } }
      }).sessionMethods.defaultBackend
    ).toBe('codex')
  })
})
