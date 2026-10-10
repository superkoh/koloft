import { describe, it, expect } from 'vitest'
import type { AttentionEvent, SessionInfo, SessionRow, WorkspaceRows } from '../../src/shared/types'
import { PLACEHOLDER_SESSION_TITLE } from '../../src/shared/types'
import {
  matchesQuery,
  paletteGroups,
  paletteSessions,
  paletteWorkspaces,
  type PaletteAction
} from '../../src/renderer/src/palette'

const HOME = '/Users/me'

function row(id: string, over: Partial<SessionRow> = {}): SessionRow {
  return {
    id,
    title: `title ${id}`,
    worktree: 'main',
    cwd: '/x',
    running: false,
    invalidCwd: false,
    mtime: 0,
    backendId: 'claude',
    host: 'local',
    ...over
  }
}

function ws(path: string, rows: SessionRow[], over: Partial<WorkspaceRows['workspace']> = {}) {
  return {
    workspace: { path, missing: false, isGit: true, hasHistory: false, ...over },
    rows
  } satisfies WorkspaceRows
}

const remote = (host: string, path: string, rows: SessionRow[]): WorkspaceRows =>
  ws(`ssh://${host}${path}`, rows, { remote: { host, path, connected: true } })

function live(sessionId: string, tabId: string, title: string): SessionInfo {
  return {
    tabId,
    sessionId,
    title,
    cwd: '/x',
    treeRoot: '/x',
    alive: true,
    backendId: 'claude',
    host: 'local'
  } as SessionInfo
}

const calls = (sessionId: string): AttentionEvent => ({
  tabId: 'none',
  sessionId,
  kind: 'turn-done',
  at: 0
})

const action = (label: string): PaletteAction => ({
  kind: 'action',
  key: label,
  label,
  run: () => {}
})

describe('command palette: session rows', () => {
  it('walks the sidebar order — workspaces in order, each parent before its children — and a session that needs you only gets the dot, not a place at the top', () => {
    const rows = [
      ws(`${HOME}/a`, [row('a1'), row('a2-child', { parentId: 'a1' }), row('a3')]),
      ws(`${HOME}/b`, [row('b1')])
    ]
    const items = paletteSessions(rows, [], [], [calls('b1')])
    expect(items.map((i) => i.row.id)).toEqual(['a1', 'a2-child', 'a3', 'b1'])
    expect(items.map((i) => i.calling)).toEqual([false, false, false, true])
  })

  it('shows the live title of a running session, and the saved one while the live title is still the placeholder', () => {
    const rows = [ws(`${HOME}/a`, [row('r1', { running: true }), row('r2', { running: true })])]
    const sessions = [live('r1', 't1', 'renamed live'), live('r2', 't2', PLACEHOLDER_SESSION_TITLE)]
    const items = paletteSessions(rows, sessions, [], [])
    expect(items.map((i) => i.title)).toEqual(['renamed live', 'title r2'])
  })

  it('notes a local row as "workspace · worktree" and a remote row as "host:workspace · worktree"', () => {
    const rows = [
      ws(`${HOME}/koloft`, [row('l', { worktree: 'feat-x' })]),
      remote('build-box', '/srv/api', [row('r')])
    ]
    expect(paletteSessions(rows, [], [], []).map((i) => i.note)).toEqual([
      'koloft · feat-x',
      'build-box:api · main'
    ])
  })
})

describe('command palette: matching', () => {
  it('needs every typed word, in any case, somewhere in the row', () => {
    expect(matchesQuery('Fix Login form main koloft', 'login KOLOFT')).toBe(true)
    expect(matchesQuery('Fix Login form main koloft', 'login widgets')).toBe(false)
    expect(matchesQuery('anything', '   ')).toBe(true)
  })

  it('finds a session by its title, worktree, workspace name or remote host', () => {
    const rows = [
      ws(`${HOME}/koloft`, [row('l', { title: 'palette design', worktree: 'feat-6' })]),
      remote('build-box', '/srv/api', [row('r', { title: 'token refresh' })])
    ]
    const found = (q: string): string[] =>
      paletteGroups(paletteSessions(rows, [], [], []), [], [], q).flatMap((g) =>
        g.items.map((i) => (i.kind === 'session' ? i.row.id : i.key))
      )
    expect(found('palette')).toEqual(['l'])
    expect(found('feat-6')).toEqual(['l'])
    expect(found('koloft')).toEqual(['l'])
    expect(found('build-box')).toEqual(['r'])
    expect(found('api token')).toEqual(['r'])
  })
})

describe('command palette: workspace rows and groups', () => {
  it('leaves out a missing workspace, shortens a local path with ~ and shows a remote one as host:path', () => {
    const items = paletteWorkspaces(
      [
        ws(`${HOME}/koloft`, []),
        ws(`${HOME}/gone`, [], { missing: true }),
        remote('build-box', '/srv/api', [])
      ],
      HOME
    )
    expect(items.map((i) => [i.name, i.note])).toEqual([
      ['koloft', '~/koloft'],
      ['api', 'build-box:/srv/api']
    ])
  })

  it('puts sessions first, then workspaces, then actions, drops an empty group, and matches an action on its name only', () => {
    const rows = [ws(`${HOME}/restart-lab`, [row('s', { title: 'restart the server' })])]
    const groups = (q: string): string[] =>
      paletteGroups(
        paletteSessions(rows, [], [], []),
        paletteWorkspaces(rows, HOME),
        [action('Restart session'), action('Settings…')],
        q
      ).map((g) => `${g.title}:${g.items.length}`)
    expect(groups('')).toEqual(['Sessions:1', 'Workspaces:1', 'Actions:2'])
    expect(groups('restart')).toEqual(['Sessions:1', 'Workspaces:1', 'Actions:1'])
    expect(groups('settings')).toEqual(['Actions:1'])
    expect(groups('zzq')).toEqual([])
  })
})
