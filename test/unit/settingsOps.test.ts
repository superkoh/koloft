import fs from 'node:fs'
import path from 'node:path'
import { describe, it, expect } from 'vitest'
import {
  buildResetPatch,
  sanitizeSettingsPatch,
  clampFontSize,
  sanitizeWorkbenchWidth,
  WORKBENCH_WIDTH_FLOOR,
  sanitizeNotesHeight,
  NOTES_HEIGHT_FLOOR,
  sanitizeLoadedSettings,
  DEFAULT_SETTINGS
} from '@shared/settingsOps'
import { GLOBAL_SCOPE } from '@shared/scope'

describe('buildResetPatch (FR-12)', () => {
  it('excludes the whole account domain: accounts, skipPermissions, fablePriority', () => {
    const patch = buildResetPatch()
    expect(patch).not.toHaveProperty('accounts')
    expect(patch).not.toHaveProperty('skipPermissions')
    expect(patch).not.toHaveProperty('fablePriority')
  })

  it('leaves the Discord block alone, so a reset keeps the butler’s channel', () => {
    expect(buildResetPatch()).not.toHaveProperty('discord')
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
        'gitAutoPull',
        'hintsOff',
        'hintsSeen',
        'keepAwake',
        'ownerAsleepSince',
        'onboardingSeen',
        'notesFolded',
        'notesHeight',
        'notifyApproval',
        'notifyApprovalSound',
        'notifyExited',
        'notifyTurnDone',
        'pluginsOn',
        'sidebarHidden',
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
  it('strips accounts but lets skipPermissions through (a legal toggle payload)', () => {
    const patch = {
      accounts: [{ name: 'x', kind: 'oauth', enabled: true }],
      skipPermissions: false,
      fontSize: 20
    } as never
    expect(sanitizeSettingsPatch(patch)).toEqual({
      skipPermissions: false,
      fontSize: 20
    })
  })

  it('strips the session defaults, which only the main process writes, since only it knows which repository a folder is', () => {
    const patch = { sessionDefaults: { '/x': { picks: {} } }, fontSize: 20 } as never
    expect(sanitizeSettingsPatch(patch)).toEqual({ fontSize: 20 })
  })

  it('strips the Discord block, which only the main process writes', () => {
    const patch = { discord: { bindings: [] }, fontSize: 20 } as never
    expect(sanitizeSettingsPatch(patch)).toEqual({ fontSize: 20 })
  })

  it('strips the butler’s conversation, which only the main process writes, and lets his name through', () => {
    const patch = {
      butlerSession: { sessionIds: ['s'] },
      butler: { name: 'Jeeves', formerNames: [] }
    } as never
    expect(sanitizeSettingsPatch(patch)).toEqual({ butler: { name: 'Jeeves', formerNames: [] } })
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
    expect(loaded.hintsSeen).toEqual(['workbench', 'approval', 'agent-web', 'worktree', 'github'])
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

describe('sanitizeLoadedSettings and the Assist choice', () => {
  it('reads a choice an older Koloft saved, its switch on or off, as the tool it named, and anything else — or none at all — as not chosen yet', () => {
    for (const on of [true, false])
      expect(sanitizeLoadedSettings({ assist: { on, backend: 'codex' } }).assist).toEqual({
        backend: 'codex'
      })
    for (const assist of [undefined, null, 'claude', { on: true }, { backend: 'gpt' }])
      expect(sanitizeLoadedSettings({ fontSize: 13, assist }).assist).toEqual({})
  })

  it('keeps each job’s own pick, and drops a pick that names no tool, a model name no command line takes, and Max on a small job', () => {
    const rows = {
      turn: { backend: 'codex', model: 'gpt-6.1-sol', effort: 'high' },
      route: { backend: 'claude', model: 'has space', effort: 'max' },
      title: { backend: 'nope', model: 'haiku' },
      docs: { model: 'haiku' },
      butler: { backend: 'agy', effort: 'max' },
      unknown: { backend: 'claude', model: 'haiku' }
    }
    expect(sanitizeLoadedSettings({ assist: { rows } }).assist).toEqual({
      rows: {
        turn: { backend: 'codex', model: 'gpt-6.1-sol', effort: 'high' },
        route: { backend: 'claude' },
        butler: { backend: 'agy', effort: 'max' }
      }
    })
  })

  it('About ▸ Reset leaves the choice alone', () => {
    expect(buildResetPatch()).not.toHaveProperty('assist')
  })
})

describe('sanitizeLoadedSettings and the "skip permission prompts" answer Koloft keeps', () => {
  it('counts an upgrade that finished Assist setup with prompts skipped as agreed, so it is not asked again; one that said "ask me first", or is still in setup, as not yet', () => {
    const done = { fontSize: 13, assist: { on: true, backend: 'claude' } }
    expect(sanitizeLoadedSettings(done).skipPermissionsAgreed).toBe(true)
    expect(sanitizeLoadedSettings({ ...done, skipPermissions: false }).skipPermissionsAgreed).toBe(
      false
    )
    expect(sanitizeLoadedSettings({ fontSize: 13 }).skipPermissionsAgreed).toBe(false)
    expect(sanitizeLoadedSettings({}).skipPermissionsAgreed).toBe(false)
  })

  it('keeps a saved answer, and About ▸ Reset leaves it alone', () => {
    const saved = { assist: { backend: 'claude' }, skipPermissionsAgreed: false }
    expect(sanitizeLoadedSettings(saved).skipPermissionsAgreed).toBe(false)
    expect(sanitizeLoadedSettings({ skipPermissionsAgreed: true }).skipPermissionsAgreed).toBe(true)
    expect(buildResetPatch()).not.toHaveProperty('skipPermissionsAgreed')
  })
})

describe('sanitizeLoadedSettings and the session defaults of each repository', () => {
  it('keeps a pick with a model name a command line takes and a known effort, the trimmed rules, and drops what is left empty', () => {
    expect(
      sanitizeLoadedSettings({
        sessionDefaults: {
          'octo/app': {
            picks: {
              claude: { model: 'opus', effort: 'high' },
              codex: { model: 'sol; rm -rf', effort: 'ultra' },
              agy: { effort: 'low' },
              nobody: { model: 'x' }
            },
            rules: '  Docs: sonnet, low.  '
          },
          '/work/empty': { picks: { claude: {} }, rules: '   ' },
          '/work/junk': 3
        } as never
      }).sessionDefaults
    ).toEqual({
      'octo/app': {
        picks: { claude: { model: 'opus', effort: 'high' }, agy: { effort: 'low' } },
        rules: 'Docs: sonnet, low.'
      }
    })
  })

  it('About ▸ Reset leaves them alone, like the to-do notes', () => {
    expect(buildResetPatch()).not.toHaveProperty('sessionDefaults')
  })
})

describe('sanitizeLoadedSettings and where new projects go', () => {
  it('starts empty — no folder is guessed — and keeps only non-empty paths per machine', () => {
    expect(sanitizeLoadedSettings({}).newProjectFolders).toEqual({})
    expect(
      sanitizeLoadedSettings({
        newProjectFolders: { local: '/Users/me/code', devbox: '', other: 3 } as never
      }).newProjectFolders
    ).toEqual({ local: '/Users/me/code' })
    expect(sanitizeLoadedSettings({ newProjectFolders: 'x' as never }).newProjectFolders).toEqual(
      {}
    )
  })

  it('About ▸ Reset leaves the remembered folders alone', () => {
    expect(buildResetPatch()).not.toHaveProperty('newProjectFolders')
  })
})

describe('sanitizeLoadedSettings and keys Koloft no longer has', () => {
  it('drops the last-seen version an older build kept for its What’s new window, so the next save clears it from disk', () => {
    expect(
      sanitizeLoadedSettings({ fontSize: 13, lastSeenVersion: '0.59.1' } as never)
    ).not.toHaveProperty('lastSeenVersion')
  })

  it('drops the cost and context usage switch an older build saved, so the next save clears it from disk', () => {
    expect(sanitizeLoadedSettings({ fontSize: 13, showUsage: true } as never)).not.toHaveProperty(
      'showUsage'
    )
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
  it('loads old settings with Claude as default and every method enabled', () => {
    expect(sanitizeLoadedSettings({}).sessionMethods).toEqual({
      defaultBackend: 'claude',
      enabled: { claude: true, codex: true, muse: true, agy: true }
    })
    expect(buildResetPatch()).not.toHaveProperty('sessionMethods')
  })
  it('replaces a disabled or unknown default with the first method still on', () => {
    for (const raw of [null, 'codex', { defaultBackend: 'unknown' }]) {
      const methods = sanitizeLoadedSettings({ sessionMethods: raw }).sessionMethods
      expect(methods.defaultBackend).toBe('claude')
      expect(methods.enabled.claude).toBe(true)
    }
    expect(
      sanitizeLoadedSettings({
        sessionMethods: { defaultBackend: 'codex', enabled: { claude: false, codex: false } }
      }).sessionMethods
    ).toEqual({
      defaultBackend: 'muse',
      enabled: { claude: false, codex: false, muse: true, agy: true }
    })
    expect(
      sanitizeLoadedSettings({
        sessionMethods: { defaultBackend: 'codex', enabled: { codex: true } }
      }).sessionMethods.defaultBackend
    ).toBe('codex')
  })
  it('lets Claude be off while another method is on, and turns Claude back on when nothing is', () => {
    expect(
      sanitizeLoadedSettings({
        sessionMethods: {
          defaultBackend: 'claude',
          enabled: { claude: false, codex: true, muse: false, agy: false }
        }
      }).sessionMethods
    ).toEqual({
      defaultBackend: 'codex',
      enabled: { claude: false, codex: true, muse: false, agy: false }
    })
    expect(
      sanitizeLoadedSettings({
        sessionMethods: {
          defaultBackend: 'agy',
          enabled: { claude: false, codex: false, muse: false, agy: false }
        }
      }).sessionMethods
    ).toEqual({
      defaultBackend: 'claude',
      enabled: { claude: true, codex: false, muse: false, agy: false }
    })
  })
  it('moves Assist off a method that is switched off, to the default method, takes back a job’s pick of it, and leaves the picks of methods that are on', () => {
    const off = { claude: false, codex: true, muse: true, agy: true }
    expect(
      sanitizeLoadedSettings({
        assist: {
          backend: 'claude',
          rows: { turn: { backend: 'claude', model: 'opus' }, route: { backend: 'agy' } }
        },
        sessionMethods: { defaultBackend: 'muse', enabled: off }
      }).assist
    ).toEqual({ backend: 'muse', rows: { route: { backend: 'agy' } } })
    expect(
      sanitizeLoadedSettings({
        assist: { backend: 'agy' },
        sessionMethods: { defaultBackend: 'muse', enabled: off }
      }).assist
    ).toEqual({ backend: 'agy' })
  })
})

describe('loading settings written before the butler', () => {
  const channel = (channelId: string) => ({ guildId: '100', channelId, name: `ch-${channelId}` })
  const oldBinding = (id: string, scope: string, channelId: string) => ({
    id,
    scope,
    backend: 'claude',
    channel: channel(channelId),
    touched: []
  })
  const v038 = {
    discord: {
      userId: '555',
      bindings: [
        {
          ...oldBinding('g', GLOBAL_SCOPE, '1'),
          sessionIds: ['old-1', 'old-2'],
          lastSessionKey: 'old-2'
        },
        { ...oldBinding('a', '/ws/a', '2'), backend: 'codex', sessionIds: ['ws-1'] }
      ]
    }
  }

  it('the global Assist’s conversation becomes the butler’s, and a workspace Assist’s is left behind', () => {
    const s = sanitizeLoadedSettings(v038)
    expect(s.butlerSession).toEqual({ sessionIds: ['old-1', 'old-2'], lastSessionKey: 'old-2' })
    expect(s.discord).toEqual({ userId: '555', channel: channel('1') })
  })

  it('the Assist records of the release before this one become the butler’s conversation, and are not written back', () => {
    const s = sanitizeLoadedSettings({
      ...v038,
      assistSessions: [
        { scope: GLOBAL_SCOPE, sessionIds: ['new-1'], lastSessionKey: 'new-1' },
        { scope: '/ws/a', sessionIds: ['ws-2'], lastSessionKey: 'ws-2' }
      ]
    })
    expect(s.butlerSession).toEqual({
      sessionIds: ['new-1', 'old-1', 'old-2'],
      lastSessionKey: 'new-1'
    })
    expect(s).not.toHaveProperty('assistSessions')
  })

  it('reading the file it writes back changes nothing', () => {
    const once = JSON.parse(JSON.stringify(sanitizeLoadedSettings(v038)))
    const twice = sanitizeLoadedSettings(once)
    expect(twice.butlerSession).toEqual(once.butlerSession)
    expect(twice.discord).toEqual(once.discord)
  })

  it('which plugins the butler’s conversation knows to be on or off survives a restart, without what is not a switch; a damaged record is dropped', () => {
    const loaded = (pluginsSeen: unknown): unknown =>
      sanitizeLoadedSettings({ butlerSession: { sessionIds: ['s1'], pluginsSeen } }).butlerSession
    expect(loaded({ key: 's1', on: { todo: false, passwords: true, github: 'off' } })).toEqual({
      sessionIds: ['s1'],
      pluginsSeen: { key: 's1', on: { todo: false, passwords: true } }
    })
    expect(loaded({ on: { todo: false } })).toEqual({ sessionIds: ['s1'] })
    expect(loaded('todo')).toEqual({ sessionIds: ['s1'] })
  })

  it('the tool Assist ran on is kept, so the owner is not asked to agree to skipping permissions again', () => {
    const s = sanitizeLoadedSettings({
      ...v038,
      assist: { on: false, backend: 'codex' },
      skipPermissions: true
    })
    expect(s.assist).toEqual({ backend: 'codex' })
    expect(s.skipPermissionsAgreed).toBe(true)
  })

  it('the butler’s conversation is left out of a settings reset and of what the window may write', () => {
    expect(buildResetPatch()).not.toHaveProperty('butlerSession')
    expect(sanitizeSettingsPatch({ butlerSession: { sessionIds: [] }, fontSize: 12 })).toEqual({
      fontSize: 12
    })
  })
})

describe('a settings file an older Koloft wrote', () => {
  const older = JSON.parse(
    fs.readFileSync(path.join(__dirname, 'settings-older-koloft', 'settings.json'), 'utf8')
  )

  it('loads the butler’s name, his conversation and the Discord block exactly as before', () => {
    const { butler, butlerSession, discord } = sanitizeLoadedSettings(older)
    expect({ butler, butlerSession, discord }).toMatchInlineSnapshot(`
      {
        "butler": {
          "formerNames": [
            "Alfred",
            "A name far longer than the forty charact",
          ],
          "name": "Jeeves the butler",
        },
        "butlerSession": {
          "carried": {
            "effort": "high",
            "model": "opus",
          },
          "knowsTodo": [
            "todo-1",
            "todo-2",
            "todo-3",
          ],
          "lastSessionKey": "key-butler",
          "sessionIds": [
            "s-butler",
            "s-assist",
            "s-binding",
          ],
        },
        "discord": {
          "category": {
            "channelId": "300",
            "guildId": "100",
            "name": "Koloft",
          },
          "channel": {
            "channelId": "200",
            "guildId": "100",
            "name": "global",
          },
          "lastMessageId": "800",
          "oldThreadsArchived": true,
          "rooms": [
            {
              "keys": [
                "claude:abc",
                "claude:def",
              ],
              "lastMessageId": "510",
              "name": "fix login",
              "putDown": true,
              "threadId": "500",
            },
            {
              "keys": [
                "codex:jkl",
              ],
              "name": "plain room",
              "threadId": "502",
            },
          ],
          "userId": "4242",
          "userName": "owner",
        },
      }
    `)
  })

  it('loads every key exactly as before: each key the file holds cleaned as before, retired keys dropped, a key Koloft does not know kept, every other key at its default', () => {
    const loaded = sanitizeLoadedSettings(older) as unknown as Record<string, unknown>
    const fromFile = Object.fromEntries(
      Object.keys(older)
        .filter((k) => k in loaded)
        .map((k) => [k, loaded[k]])
    )
    expect(fromFile).toMatchInlineSnapshot(`
      {
        "aKeyANewerKoloftWrote": {
          "kept": true,
        },
        "assist": {
          "backend": "claude",
        },
        "butler": {
          "formerNames": [
            "Alfred",
            "A name far longer than the forty charact",
          ],
          "name": "Jeeves the butler",
        },
        "butlerSession": {
          "carried": {
            "effort": "high",
            "model": "opus",
          },
          "knowsTodo": [
            "todo-1",
            "todo-2",
            "todo-3",
          ],
          "lastSessionKey": "key-butler",
          "sessionIds": [
            "s-butler",
            "s-assist",
            "s-binding",
          ],
        },
        "discord": {
          "category": {
            "channelId": "300",
            "guildId": "100",
            "name": "Koloft",
          },
          "channel": {
            "channelId": "200",
            "guildId": "100",
            "name": "global",
          },
          "lastMessageId": "800",
          "oldThreadsArchived": true,
          "rooms": [
            {
              "keys": [
                "claude:abc",
                "claude:def",
              ],
              "lastMessageId": "510",
              "name": "fix login",
              "putDown": true,
              "threadId": "500",
            },
            {
              "keys": [
                "codex:jkl",
              ],
              "name": "plain room",
              "threadId": "502",
            },
          ],
          "userId": "4242",
          "userName": "owner",
        },
        "fontSize": 13,
        "skipPermissions": true,
      }
    `)
    expect(Object.keys(loaded).sort()).toEqual(
      [...Object.keys(DEFAULT_SETTINGS), 'aKeyANewerKoloftWrote'].sort()
    )
    for (const [k, v] of Object.entries(DEFAULT_SETTINGS))
      if (
        !(k in older) &&
        k !== 'skipPermissionsAgreed' &&
        k !== 'onboardingSeen' &&
        k !== 'hintsSeen'
      )
        expect(loaded[k], k).toEqual(v)
  })

  it('loads the same again from what it writes back', () => {
    const loaded = sanitizeLoadedSettings(older)
    expect(sanitizeLoadedSettings(JSON.parse(JSON.stringify(loaded)))).toStrictEqual(loaded)
  })
})
