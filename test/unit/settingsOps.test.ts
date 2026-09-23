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

// Expectations are hand-derived from the original case list (FR-08 / FR-12 / FR-13 and
// the fontSize edge case), not from running the implementation.

describe('buildResetPatch (FR-12)', () => {
  it('excludes the whole account domain: accounts, multiAccount, skipPermissions, fablePriority', () => {
    const patch = buildResetPatch()
    expect(patch).not.toHaveProperty('accounts')
    expect(patch).not.toHaveProperty('multiAccount')
    expect(patch).not.toHaveProperty('skipPermissions')
    expect(patch).not.toHaveProperty('fablePriority')
  })

  it('carries every non-account default', () => {
    const patch = buildResetPatch()
    // every Settings key minus the 4 account-domain ones
    expect(Object.keys(patch).sort()).toEqual(
      [
        // D2: browser control resets to ON with everything else — it is a normal
        // setting with a default, not a consent that a reset should silently re-grant
        // (the per-session takeover is asked again either way, D10)
        'browserControl',
        'browserPaneWidth',
        'dockBadge',
        'filePaneWidth',
        'fileTreeHeight',
        'fontFamily',
        'fontSize',
        'gitAutoFetch',
        // a reset re-runs the welcome and re-arms the tips — that IS what
        // "Reset to defaults" means for a first-run aid
        'hintsOff',
        'hintsSeen',
        // keepAwake resets to ON with everything else — it is a normal setting
        'keepAwake',
        'lastSeenVersion',
        'onboardingSeen',
        // the Notes island's size resets with everything else
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
    // spot-check values are the factory defaults
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
    // input object is not mutated by the strip
    expect(patch).toHaveProperty('accounts')
  })
})

// FR-08/NFR-07: the Workbench's saved width, read off a hand-editable settings.json.
// A hand-editable value that is arithmetic all the way to a CSS width, with a floor:
// below 440 a `web` tab hits
// most sites' mobile breakpoint, and any tab in the merged panel can be a `web` one.
describe('sanitizeWorkbenchWidth (FR-08/NFR-07, the disk boundary)', () => {
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
})

// the Notes island's saved height, repaired on load just like the Workbench width —
// the number is arithmetic all the way to a CSS height.
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

// settings.json is hand-editable, and loadSettings used to merge it raw — a typed
// `notesHeight: 0` or `"tall"`, or a string notesFolded, reached the renderer untouched.
// The repair happens on load now, in the one place every reader goes through.
describe('sanitizeLoadedSettings and the Notes keys', () => {
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

// U-OB-03: a settings.json written before this release has no onboarding keys in
// it. That is an upgrade — the user already knows the app — so the welcome and the tips
// count as seen. An empty document says nothing about the user and keeps the defaults.
describe('sanitizeLoadedSettings and the onboarding keys', () => {
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

describe('clampFontSize (FR-08 edge case)', () => {
  it('passes in-range values through', () => {
    expect(clampFontSize('13')).toBe(13)
    expect(clampFontSize('8')).toBe(8)
    expect(clampFontSize('32')).toBe(32)
  })

  it('clamps typed out-of-range values (input min/max does not)', () => {
    expect(clampFontSize('7')).toBe(8)
    expect(clampFontSize('33')).toBe(32)
    expect(clampFontSize('99')).toBe(32) // the spec's named example
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
