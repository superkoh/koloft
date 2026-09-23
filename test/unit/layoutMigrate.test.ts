import { describe, expect, it } from 'vitest'
import { migrateLayout, serializeLayout, type MigrateDeps } from '../../src/main/layoutMigrate'
import type { LayoutV4 } from '@shared/types'
import { DEFAULT_PANEL_OPEN, PERSISTED_TAB_CAP } from '@shared/workbenchState'

// Fake project-root table standing in for projectInfoFor(cwd).root: worktree and
// subdir cwds merge to the repo root, unknown (non-git) paths return themselves.
const ROOTS: Record<string, string> = {
  '/repo/.claude/worktrees/wt1': '/repo',
  '/repo/src/deep': '/repo',
  '/repo': '/repo',
  '/dead-repo/sub': '/dead-repo'
}

const deps: MigrateDeps = {
  projectRootOf: (p) => ROOTS[p] ?? p,
  dirExists: (p) => p !== '/dead-repo'
}

const V1 = {
  version: 1,
  activeIndex: 1,
  tabs: [
    { kind: 'claude', cwd: '/repo/.claude/worktrees/wt1', sessionId: 'sid-1', title: 'wt work' },
    { kind: 'claude', cwd: '/repo/src/deep', sessionId: 'sid-2', title: 'Custom Title' },
    { kind: 'shell', cwd: '/repo', title: 'zsh' },
    { kind: 'claude', cwd: '/alpha', sessionId: 'sid-3', title: 'alpha work' },
    { kind: 'shell', cwd: '/zeta', title: 'zsh' }, // pure-shell group — must vanish
    { kind: 'claude', cwd: '/dead-repo/sub', sessionId: 'sid-4', title: 'gone' }
  ]
}

const SAFE_EMPTY: LayoutV4 = {
  version: 4,
  workspaces: [],
  workbench: { defaultOpen: false },
  sessions: {}
}

// The shipped default is what every branch below lands on, and the one number the whole
// "hidden unless the user opened it" rule hangs off — a suite that spelled `false` at
// each site would go green against a build that flipped the constant back.
it('the shipped panel default is collapsed', () => {
  expect(DEFAULT_PANEL_OPEN).toBe(false)
})

describe('migrateLayout (v1 → v4, logic.md §9)', () => {
  it('T-MIG-01 idempotent: same v1 twice → same output', () => {
    const first = migrateLayout(V1, deps)
    const second = migrateLayout(V1, deps)
    expect(second).toEqual(first)
  })

  // Decided: the sidebar defaults to sessions Koloft itself drove. A v1 claude
  // tab IS such a session, so its id seeds sessions[] — otherwise every open session
  // would vanish from the sidebar on upgrade.
  it('seeds sessions[] from v1 claude tabs so the owned-only sidebar still shows them', () => {
    const out = migrateLayout(V1, deps)
    expect(Object.keys(out.sessions).sort()).toEqual(['sid-1', 'sid-2', 'sid-3', 'sid-4'])
    expect(out.sessions['sid-1']).toEqual({ open: false, tabs: [] })
  })

  it('T-MIG-02 merges worktree and subdir cwds via projectRootOf; non-git cwd kept as-is', () => {
    const out = migrateLayout(V1, deps)
    const paths = out.workspaces.map((w) => w.path)
    // worktree cwd + main-checkout subdir collapse into one /repo entry (dedupe)
    expect(paths.filter((p) => p === '/repo')).toEqual(['/repo'])
    // non-git cwd: projectRootOf returns it unchanged and it is persisted as such
    expect(paths).toContain('/alpha')
  })

  it('T-MIG-03 skips cwds whose merged root no longer exists (no dead workspace)', () => {
    const out = migrateLayout(V1, deps)
    const paths = out.workspaces.map((w) => w.path)
    expect(paths).not.toContain('/dead-repo')
    expect(paths).not.toContain('/dead-repo/sub')
    // the live roots still made it — the skip is per-entry, not wholesale
    expect(paths).toContain('/repo')
  })

  it('T-MIG-04 writes workspaces[] in alphabetical order regardless of tab order', () => {
    const shuffled = {
      version: 1,
      tabs: [
        { kind: 'claude', cwd: '/zeta', title: 'z' },
        { kind: 'claude', cwd: '/repo/src/deep', title: 'r' },
        { kind: 'claude', cwd: '/alpha', title: 'a' }
      ]
    }
    expect(migrateLayout(shuffled, deps).workspaces).toEqual([
      { path: '/alpha' },
      { path: '/repo' },
      { path: '/zeta' }
    ])
  })

  it('T-MIG-05 drops shell tabs and pure-shell groups silently, no legacy fields (A11)', () => {
    const out = migrateLayout(V1, deps)
    const paths = out.workspaces.map((w) => w.path)
    // /zeta only ever hosted a shell tab → whole group vanishes
    expect(paths).not.toContain('/zeta')
    // groups with claude tabs still migrate (the drop is tab-kind scoped)
    expect(paths).toEqual(['/alpha', '/repo'])
    // no v1 residue: exactly the v4 keys, nothing else
    expect(Object.keys(out).sort()).toEqual(['sessions', 'version', 'workbench', 'workspaces'])
  })

  it('T-MIG-06 the shipped default, v1 titles dropped, no activeSessionId (A10)', () => {
    const out = migrateLayout(V1, deps)
    expect(out.version).toBe(4)
    expect(out.workbench).toEqual({ defaultOpen: DEFAULT_PANEL_OPEN })
    // sessions[] carries ONLY ownership seeds (see the seeding case) — never v1
    // titles or an active pointer
    expect('activeSessionId' in out).toBe(false)
    expect('activeIndex' in out).toBe(false)
    expect(JSON.stringify(out)).not.toContain('Custom Title')
  })

  it('T-AGG-09② panel state round-trip serialize → parse → load untouched', () => {
    const doc: LayoutV4 = {
      version: 4,
      // non-alphabetical on purpose: a round-trip must not re-sort (append semantics)
      workspaces: [{ path: '/zzz' }, { path: '/aaa' }],
      workbench: { defaultOpen: true },
      sessions: {
        's-open': {
          open: true,
          tabs: [
            { kind: 'web', title: 'app', url: 'http://localhost:5173/' },
            { kind: 'file', title: 'README.md', path: '/zzz/README.md', view: 'diff' }
          ]
        },
        's-collapsed': { open: false, tabs: [] }
      }
    }
    // deps would mangle everything if the v1 branch ran — the v4 path must not consult them
    const mangling: MigrateDeps = { dirExists: () => false, projectRootOf: () => '/mangled' }
    expect(migrateLayout(JSON.parse(serializeLayout(doc)), mangling)).toEqual(doc)
  })

  // `defaultOpen` is a knob with a shipped value, so a document that never mentions it is
  // complete — the guard must not send it down the "unrecognized → empty" path and wipe
  // the workspace list (the NFR-06 trap) over a missing optional.
  it('a v4 document with no `workbench` block is whole: the shipped default fills in', () => {
    const out = migrateLayout({ version: 4, workspaces: [{ path: '/repo' }], sessions: {} }, deps)
    expect(out).toEqual({
      version: 4,
      workspaces: [{ path: '/repo' }],
      workbench: { defaultOpen: DEFAULT_PANEL_OPEN },
      sessions: {}
    })
  })

  it('corrupt or unknown shape → safe empty v4 (§9)', () => {
    expect(migrateLayout(null, deps)).toEqual(SAFE_EMPTY)
    expect(migrateLayout('garbage', deps)).toEqual(SAFE_EMPTY)
    expect(migrateLayout({ tabs: 'nope' }, deps)).toEqual(SAFE_EMPTY)
    expect(migrateLayout({ version: 5, future: true }, deps)).toEqual(SAFE_EMPTY)
    // version says 4 but the body is mangled — still the safe empty doc
    expect(migrateLayout({ version: 4, workspaces: 'x' }, deps)).toEqual(SAFE_EMPTY)
  })
})

// The bump's one job. Every build before v4 seeded a session's `open` from a default that
// shipped `true` and had no UI, so a stored `open: true` said nothing about the user and
// the panel sprang open on every new session and every resume. The upgrade lands every
// panel collapsed ONCE; from then on a stored `open: true` is the user's own expand and is
// honored — which is the whole of "remembered across a restart".
describe('migrateLayout: v3 → v4, every panel lands collapsed once (2026-09-03)', () => {
  const V3 = {
    version: 3,
    workspaces: [{ path: '/zzz' }, { path: '/aaa' }],
    workbench: { defaultOpen: true },
    sessions: {
      's-seeded': { open: true, tabs: [] },
      's-worked': {
        open: true,
        tabs: [
          { kind: 'web', title: 'app', url: 'http://localhost:5173/' },
          { kind: 'file', title: 'README.md', path: '/zzz/README.md', view: 'diff' }
        ]
      },
      's-collapsed': {
        open: false,
        tabs: [{ kind: 'web', title: 'docs', url: 'https://example.com/docs' }]
      }
    }
  }

  it('every session lands collapsed, whatever its v3 flag said', () => {
    const out = migrateLayout(V3, deps)
    expect(out.version).toBe(4)
    expect(out.sessions['s-seeded'].open).toBe(false)
    expect(out.sessions['s-worked'].open).toBe(false)
    expect(out.sessions['s-collapsed'].open).toBe(false)
  })

  it('the tab sets ride through untouched — a bookkeeping change never drops a tab', () => {
    const out = migrateLayout(V3, deps)
    expect(out.sessions['s-worked'].tabs).toEqual(V3.sessions['s-worked'].tabs)
    expect(out.sessions['s-collapsed'].tabs).toEqual(V3.sessions['s-collapsed'].tabs)
    expect(out.sessions['s-seeded'].tabs).toEqual([])
  })

  it('the default a never-seen session inherits is the shipped one, not the v3 file’s', () => {
    expect(migrateLayout(V3, deps).workbench.defaultOpen).toBe(DEFAULT_PANEL_OPEN)
  })

  it('workspaces ride through in order (NFR-06)', () => {
    const out = migrateLayout(V3, deps)
    expect(out.workspaces).toEqual([{ path: '/zzz' }, { path: '/aaa' }])
    expect(out).not.toEqual(SAFE_EMPTY)
  })

  // The half that makes the reset safe to ship: it happens on the version edge and
  // nowhere else, so the panel a user expands after the upgrade stays expanded.
  it('runs once — a v4 document keeps a stored `open: true`, and a stored default', () => {
    const upgraded = migrateLayout(V3, deps)
    const opened: LayoutV4 = {
      ...upgraded,
      workbench: { defaultOpen: true },
      sessions: {
        ...upgraded.sessions,
        's-worked': { ...upgraded.sessions['s-worked'], open: true }
      }
    }
    const reloaded = migrateLayout(JSON.parse(serializeLayout(opened)), deps)
    expect(reloaded.sessions['s-worked'].open).toBe(true)
    expect(reloaded.sessions['s-seeded'].open).toBe(false)
    expect(reloaded.workbench.defaultOpen).toBe(true)
  })

  it('the second cold start is byte-identical to the first (idempotent)', () => {
    const first = migrateLayout(V3, deps)
    const reloaded = migrateLayout(JSON.parse(serializeLayout(first)), deps)
    expect(reloaded).toEqual(first)
    expect(serializeLayout(reloaded)).toBe(serializeLayout(first))
  })

  it('a dirty v3 entry is repaired per item on the way, never dropped whole (WB-P04)', () => {
    const out = migrateLayout(
      {
        ...V3,
        sessions: {
          s: {
            open: 'yes',
            tabs: [
              { kind: 'web', title: 'no url' },
              { kind: 'wat' },
              { kind: 'web', title: 'ok', url: 'http://a/' }
            ]
          }
        }
      },
      deps
    )
    expect(out.sessions.s).toEqual({
      open: false,
      tabs: [{ kind: 'web', title: 'ok', url: 'http://a/' }]
    })
  })
})

// NFR-06 / WB-P03. The trap this suite guards: the old `isLayoutV2` required
// `isRecord(raw.aux)` and everything it did not recognize degraded to the safe EMPTY
// document — so renaming `aux` → `workbench` without a version-gated second guard would
// have dropped every existing layout.json into the v1 branch and wiped the workspace list.
describe('migrateLayout: v2 → v4, the Workbench merge', () => {
  const V2 = {
    version: 2,
    workspaces: [{ path: '/zzz' }, { path: '/aaa' }],
    aux: { defaultMode: 'preview' },
    sessions: {
      's-browser': {
        auxMode: 'browser',
        browser: {
          tabs: [
            { url: 'http://localhost:5173/', title: 'app' },
            { url: 'https://example.com/docs', title: 'docs' }
          ]
        }
      },
      's-preview': { auxMode: 'preview' },
      's-collapsed': { auxMode: null }
    }
  }

  it('WB-P03 preserves every workspace and session entry', () => {
    const out = migrateLayout(V2, deps)
    expect(out.version).toBe(4)
    // order is append semantics, not alphabetical — the converter must not re-sort
    expect(out.workspaces).toEqual([{ path: '/zzz' }, { path: '/aaa' }])
    expect(Object.keys(out.sessions).sort()).toEqual(['s-browser', 's-collapsed', 's-preview'])
  })

  // v2 seeded `auxMode` from `aux.defaultMode` at every bind, exactly as v3 seeded `open`,
  // so a non-null mode carried no more intent than a v3 `open: true` — every v2 session
  // lands collapsed like every v3 one, the former `'terminal'` value included.
  it('WB-P03 lands every session collapsed — auxMode is not projected onto `open`', () => {
    const out = migrateLayout(
      {
        ...V2,
        sessions: { ...V2.sessions, 's-term': { auxMode: 'terminal', tabs: [{ title: 'zsh' }] } }
      },
      deps
    )
    expect(out.sessions['s-browser'].open).toBe(false)
    expect(out.sessions['s-preview'].open).toBe(false)
    expect(out.sessions['s-collapsed'].open).toBe(false)
    expect(out.sessions['s-term'].open).toBe(false)
  })

  it('WB-P03 converts the Browser tabs to kind:web, order preserved', () => {
    const out = migrateLayout(V2, deps)
    expect(out.sessions['s-browser'].tabs).toEqual([
      { kind: 'web', title: 'app', url: 'http://localhost:5173/' },
      { kind: 'web', title: 'docs', url: 'https://example.com/docs' }
    ])
    // FR-02: `files` is implied, never stored — a preview session converts to no tabs
    expect(out.sessions['s-preview'].tabs).toEqual([])
  })

  it('the default lands on the shipped one, whatever aux.defaultMode said', () => {
    for (const defaultMode of ['preview', 'browser', 'terminal', null]) {
      expect(migrateLayout({ ...V2, aux: { defaultMode } }, deps).workbench.defaultOpen).toBe(
        DEFAULT_PANEL_OPEN
      )
    }
  })

  // §Edge: "never degrade to an empty document because a structure isn't recognized"
  it('WB-P03 the data-loss trap: a v2 document never degrades to empty', () => {
    const out = migrateLayout(V2, deps)
    expect(out).not.toEqual(SAFE_EMPTY)
    expect(out.workspaces).toHaveLength(2)
    expect(Object.keys(out.sessions)).toHaveLength(3)
  })

  it('WB-P03 the second cold start is byte-identical to the first (idempotent)', () => {
    const first = migrateLayout(V2, deps)
    const reloaded = migrateLayout(JSON.parse(serializeLayout(first)), deps)
    expect(reloaded).toEqual(first)
    expect(serializeLayout(reloaded)).toBe(serializeLayout(first))
  })

  // D1/D12: `sessions[].tabs` held the former aux Terminal's strip, and every build
  // that wrote one is upgrading FROM a file full of them. It has no counterpart in v4 and
  // must not survive as a dead structure — the `tabs` key that DOES survive is the
  // Workbench's own, rebuilt from `browser`.
  it('drops the retired per-session terminal strip, keeping the Browser tabs', () => {
    const out = migrateLayout(
      {
        ...V2,
        sessions: {
          's-old': {
            auxMode: 'browser',
            tabs: [{ title: 'zsh' }, { title: 'build' }],
            browser: { tabs: [{ url: 'http://localhost:5173/', title: 'app' }] }
          }
        }
      },
      deps
    )
    expect(out.sessions['s-old']).toEqual({
      open: false,
      tabs: [{ kind: 'web', title: 'app', url: 'http://localhost:5173/' }]
    })
  })

  // unread was never persisted in v2 either (restoreTabSet rebuilt every tab with
  // unread:false), so there is nothing to carry and nothing to invent
  it('carries no unread mark, and drops a browser tab with no url', () => {
    const out = migrateLayout(
      {
        ...V2,
        sessions: {
          s: {
            auxMode: 'browser',
            browser: {
              tabs: [
                { url: 'http://a/', title: 'A', unread: true },
                { title: 'no url' },
                { url: 'http://c/', title: 'C' }
              ]
            }
          }
        }
      },
      deps
    )
    expect(out.sessions.s.tabs).toEqual([
      { kind: 'web', title: 'A', url: 'http://a/' },
      { kind: 'web', title: 'C', url: 'http://c/' }
    ])
  })

  // §06 — flipped. This used to pin "the island's tabs ride through untouched";
  // there is no island, so the key is DROPPED instead, in every branch the migration has.
  // Asserting the whole document rather than the one key is what carries it: a build that
  // kept the key would still answer `undefined` to a narrower `out.globalTerminal` check
  // if it had renamed it, and the point is that nothing of the island survives at all.
  it('drops the retired globalTerminal key from every document that still has it', () => {
    const seeded = { visible: true, tabs: [{ title: 'zsh', cwd: '/repo' }] }
    const v3 = {
      version: 3,
      workspaces: [{ path: '/repo' }],
      workbench: { defaultOpen: true },
      sessions: {}
    }
    const v4 = {
      version: 4,
      workspaces: [{ path: '/repo' }],
      workbench: { defaultOpen: false },
      sessions: {}
    }
    for (const doc of [
      { ...V2, globalTerminal: seeded },
      { ...v3, globalTerminal: seeded },
      { ...v4, globalTerminal: seeded }
    ]) {
      expect('globalTerminal' in migrateLayout(doc, deps)).toBe(false)
    }
  })

  it('an old file without the key was always a valid document, and still is', () => {
    expect('globalTerminal' in migrateLayout(V2, deps)).toBe(false)
  })
})

// WB-P04 / §Edge: "sanitize per kind item by item, drop what can't be repaired, truncate
// to the cap, restore the rest — one dirty entry never blanks the whole panel". The
// read path shares ONE sanitizer with the write path, so a hand-edited document and a
// buggy renderer submission are repaired identically.
describe('migrateLayout: a dirty v4 document (WB-P04)', () => {
  const dirty = {
    version: 4,
    workspaces: [{ path: '/repo' }],
    // the seam a test (or a hand edit) uses to get the pre-v4 "arrives expanded" feel
    workbench: { defaultOpen: true },
    sessions: {
      s1: {
        open: true,
        tabs: [
          { kind: 'web', title: 'no url' }, // unrenderable — nothing to repair it WITH
          { kind: 'terminal', title: 'from a build that got this wrong' },
          ...Array.from({ length: 12 }, (_, i) => ({
            kind: 'web',
            title: `T${i}`,
            url: `http://t${i}/`
          }))
        ]
      }
    }
  }

  it('drops the two invalid tabs and truncates the valid ones to the cap', () => {
    const tabs = migrateLayout(dirty, deps).sessions.s1.tabs
    expect(tabs).toHaveLength(PERSISTED_TAB_CAP)
    expect(tabs.every((t) => t.kind === 'web' && !!t.url)).toBe(true)
    // truncation keeps the head of the list, in order — not an arbitrary subset
    expect(tabs.map((t) => t.title)).toEqual(['T0', 'T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'])
  })

  it('loses nothing else: the panel restores rather than blanking', () => {
    const out = migrateLayout(dirty, deps)
    expect(out.workspaces).toEqual([{ path: '/repo' }])
    expect(out.sessions.s1.open).toBe(true)
    expect(out.workbench.defaultOpen).toBe(true)
  })

  // FR-22's cap is per kind, so a session holding both kinds keeps 8 of each
  it('truncates per kind, not across the whole list', () => {
    const out = migrateLayout(
      {
        ...dirty,
        sessions: {
          s1: {
            open: true,
            tabs: [
              ...Array.from({ length: 10 }, (_, i) => ({
                kind: 'web',
                title: `W${i}`,
                url: `http://w${i}/`
              })),
              ...Array.from({ length: 10 }, (_, i) => ({
                kind: 'file',
                title: `F${i}`,
                path: `/repo/f${i}.ts`
              }))
            ]
          }
        }
      },
      deps
    )
    const tabs = out.sessions.s1.tabs
    expect(tabs.filter((t) => t.kind === 'web')).toHaveLength(PERSISTED_TAB_CAP)
    expect(tabs.filter((t) => t.kind === 'file')).toHaveLength(PERSISTED_TAB_CAP)
  })

  it('a corrupt `open` flag lands on the document’s own default, else the shipped one', () => {
    const entry = { open: 'yes', tabs: [] }
    expect(migrateLayout({ ...dirty, sessions: { s: entry } }, deps).sessions.s.open).toBe(true)
    expect(
      migrateLayout({ ...dirty, workbench: { defaultOpen: false }, sessions: { s: entry } }, deps)
        .sessions.s.open
    ).toBe(false)
    const { workbench: _dropped, ...noDefault } = dirty
    expect(migrateLayout({ ...noDefault, sessions: { s: entry } }, deps).sessions.s.open).toBe(
      DEFAULT_PANEL_OPEN
    )
  })
})
