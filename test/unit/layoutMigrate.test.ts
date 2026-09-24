import { describe, expect, it } from 'vitest'
import { migrateLayout, serializeLayout, type MigrateDeps } from '../../src/main/layoutMigrate'
import type { LayoutV5 } from '@shared/types'
import { DEFAULT_PANEL_OPEN, PERSISTED_TAB_CAP } from '@shared/workbenchState'

const FAKE_PROJECT_ROOT_BY_CWD: Record<string, string> = {
  '/repo/.claude/worktrees/wt1': '/repo',
  '/repo/src/deep': '/repo',
  '/repo': '/repo',
  '/dead-repo/sub': '/dead-repo'
}

const deps: MigrateDeps = {
  projectRootOf: (p) => FAKE_PROJECT_ROOT_BY_CWD[p] ?? p,
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
    { kind: 'shell', cwd: '/zeta', title: 'zsh' },
    { kind: 'claude', cwd: '/dead-repo/sub', sessionId: 'sid-4', title: 'gone' }
  ]
}

const SAFE_EMPTY: LayoutV5 = {
  version: 5,
  workspaces: [],
  workbench: { defaultOpen: false },
  members: [],
  sessions: {}
}

it('the shipped panel default is collapsed', () => {
  expect(DEFAULT_PANEL_OPEN).toBe(false)
})

describe('migrateLayout (v1 → v5)', () => {
  it('T-MIG-01 idempotent: same v1 twice → same output', () => {
    const first = migrateLayout(V1, deps)
    const second = migrateLayout(V1, deps)
    expect(second).toEqual(first)
  })

  it('seeds members and sessions from v1 claude tabs so the owned-only sidebar still shows them', () => {
    const out = migrateLayout(V1, deps)
    expect([...out.members].sort()).toEqual(['sid-1', 'sid-2', 'sid-3', 'sid-4'])
    expect(Object.keys(out.sessions).sort()).toEqual(['sid-1', 'sid-2', 'sid-3', 'sid-4'])
    expect(out.sessions['sid-1']).toEqual({ open: false, tabs: [] })
  })

  it('T-MIG-02 merges worktree and subdir cwds via projectRootOf; non-git cwd kept as-is', () => {
    const out = migrateLayout(V1, deps)
    const paths = out.workspaces.map((w) => w.path)
    expect(paths.filter((p) => p === '/repo')).toEqual(['/repo'])
    expect(paths).toContain('/alpha')
  })

  it('T-MIG-03 skips cwds whose merged root no longer exists (no dead workspace)', () => {
    const out = migrateLayout(V1, deps)
    const paths = out.workspaces.map((w) => w.path)
    expect(paths).not.toContain('/dead-repo')
    expect(paths).not.toContain('/dead-repo/sub')
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
    expect(paths).not.toContain('/zeta')
    expect(paths).toEqual(['/alpha', '/repo'])
    expect(Object.keys(out).sort()).toEqual([
      'members',
      'sessions',
      'version',
      'workbench',
      'workspaces'
    ])
  })

  it('T-MIG-06 the shipped default, v1 titles dropped, no activeSessionId (A10)', () => {
    const out = migrateLayout(V1, deps)
    expect(out.version).toBe(5)
    expect(out.workbench).toEqual({ defaultOpen: DEFAULT_PANEL_OPEN })
    expect('activeSessionId' in out).toBe(false)
    expect('activeIndex' in out).toBe(false)
    expect(JSON.stringify(out)).not.toContain('Custom Title')
  })

  it('T-AGG-09② panel state round-trip serialize → parse → load untouched', () => {
    const doc: LayoutV5 = {
      version: 5,
      workspaces: [{ path: '/zzz' }, { path: '/aaa' }],
      workbench: { defaultOpen: true },
      members: ['s-open', 's-collapsed'],
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
    const mangling: MigrateDeps = { dirExists: () => false, projectRootOf: () => '/mangled' }
    expect(migrateLayout(JSON.parse(serializeLayout(doc)), mangling)).toEqual(doc)
  })

  it('a v4 document with no `workbench` block is whole: the shipped default fills in', () => {
    const out = migrateLayout({ version: 4, workspaces: [{ path: '/repo' }], sessions: {} }, deps)
    expect(out).toEqual({
      version: 5,
      workspaces: [{ path: '/repo' }],
      workbench: { defaultOpen: DEFAULT_PANEL_OPEN },
      members: [],
      sessions: {}
    })
  })

  it('corrupt or unknown shape → safe empty layout', () => {
    expect(migrateLayout(null, deps)).toEqual(SAFE_EMPTY)
    expect(migrateLayout('garbage', deps)).toEqual(SAFE_EMPTY)
    expect(migrateLayout({ tabs: 'nope' }, deps)).toEqual(SAFE_EMPTY)
    expect(migrateLayout({ version: 6, future: true }, deps)).toEqual(SAFE_EMPTY)
    expect(migrateLayout({ version: 4, workspaces: 'x' }, deps)).toEqual(SAFE_EMPTY)
  })
})

describe('migrateLayout: v3 → v5, every panel lands collapsed once, since a v3 `open: true` came from a default and not the user', () => {
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
    expect(out.version).toBe(5)
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

  it('runs once — a v5 document keeps a stored `open: true`, and a stored default', () => {
    const upgraded = migrateLayout(V3, deps)
    const opened: LayoutV5 = {
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

describe('migrateLayout: v2 → v5, the Workbench merge', () => {
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
    expect(out.version).toBe(5)
    expect(out.workspaces).toEqual([{ path: '/zzz' }, { path: '/aaa' }])
    expect(Object.keys(out.sessions).sort()).toEqual(['s-browser', 's-collapsed', 's-preview'])
  })

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
    expect(out.sessions['s-preview'].tabs).toEqual([])
  })

  it('the default lands on the shipped one, whatever aux.defaultMode said', () => {
    for (const defaultMode of ['preview', 'browser', 'terminal', null]) {
      expect(migrateLayout({ ...V2, aux: { defaultMode } }, deps).workbench.defaultOpen).toBe(
        DEFAULT_PANEL_OPEN
      )
    }
  })

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

describe('migrateLayout: a dirty v4 document (WB-P04)', () => {
  const dirty = {
    version: 4,
    workspaces: [{ path: '/repo' }],
    workbench: { defaultOpen: true },
    sessions: {
      s1: {
        open: true,
        tabs: [
          { kind: 'web', title: 'no url' },
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
    expect(tabs.map((t) => t.title)).toEqual(['T0', 'T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'])
  })

  it('loses nothing else: the panel restores rather than blanking', () => {
    const out = migrateLayout(dirty, deps)
    expect(out.workspaces).toEqual([{ path: '/repo' }])
    expect(out.sessions.s1.open).toBe(true)
    expect(out.workbench.defaultOpen).toBe(true)
  })

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

describe('migrateLayout: v4 → v5, sidebar membership moves out of the Workbench state map', () => {
  const codexKey = 'codex:local:00000000-0000-4000-8000-000000000001'
  const V4 = {
    version: 4,
    workspaces: [{ path: '/repo' }],
    workbench: { defaultOpen: true },
    sessions: {
      'claude-a': { open: true, tabs: [{ kind: 'web', title: 'app', url: 'http://a/' }] },
      'claude-b': { open: false, tabs: [] },
      [codexKey]: { open: true, tabs: [] }
    }
  }

  it('every Claude session of a v4 document becomes a member and keeps its Workbench state', () => {
    const out = migrateLayout(V4, deps)
    expect(out.version).toBe(5)
    expect(out.members).toEqual(['claude-a', 'claude-b'])
    expect(out.sessions['claude-a']).toEqual(V4.sessions['claude-a'])
    expect(out.sessions['claude-b']).toEqual(V4.sessions['claude-b'])
  })

  it('a Codex session keeps its Workbench state but is never counted as a Claude member', () => {
    const out = migrateLayout(V4, deps)
    expect(out.members).not.toContain(codexKey)
    expect(out.sessions[codexKey]).toEqual({ open: true, tabs: [] })
  })

  it('a v5 member with no Workbench state stays a member, and a v5 key with state alone stays out', () => {
    const out = migrateLayout(
      {
        version: 5,
        workspaces: [],
        workbench: { defaultOpen: false },
        members: ['member-only', 7, ''],
        sessions: { 'state-only': { open: true, tabs: [] } }
      },
      deps
    )
    expect(out.members).toEqual(['member-only'])
    expect(Object.keys(out.sessions)).toEqual(['state-only'])
  })
})
