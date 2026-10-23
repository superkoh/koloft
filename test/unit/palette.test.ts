import { describe, it, expect } from 'vitest'
import type {
  AttentionEvent,
  SessionInfo,
  SessionRow,
  SessionSearchHit,
  WorkspaceRows
} from '../../src/shared/types'
import { PLACEHOLDER_SESSION_TITLE } from '../../src/shared/types'
import {
  completeMention,
  matchesQuery,
  mentionCandidates,
  mentionTyping,
  paletteGroups,
  paletteSessions,
  paletteWorkspaces,
  namedWorkspaces,
  pinnedWorkspace,
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
  words: [],
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

  it('lists nothing until something is typed, then puts sessions first, then workspaces, then actions, drops an empty group, and matches an action without keywords on its name only', () => {
    const rows = [ws(`${HOME}/restart-lab`, [row('s', { title: 'restart the server' })])]
    const groups = (q: string): string[] =>
      paletteGroups(
        paletteSessions(rows, [], [], []),
        paletteWorkspaces(rows, HOME),
        [action('Restart session'), action('Settings…')],
        q
      ).map((g) => `${g.title}:${g.items.length}`)
    expect(groups('')).toEqual([])
    expect(groups('   ')).toEqual([])
    expect(groups('restart')).toEqual(['Sessions:1', 'Workspaces:1', 'Actions:1'])
    expect(groups('settings')).toEqual(['Actions:1'])
    expect(groups('zzq')).toEqual([])
  })

  it('finds a feature by any of its keywords, also when the keyword sits inside a longer sentence, whatever the language', () => {
    const settings: PaletteAction = { ...action('Settings…'), words: ['设置', 'preferences'] }
    const found = (q: string): number =>
      paletteGroups([], [], [settings], q).flatMap((g) => g.items).length
    expect(found('设置')).toBe(1)
    expect(found('帮我打开设置')).toBe(1)
    expect(found('Preferences')).toBe(1)
    expect(found('sett')).toBe(1)
    expect(found('关于')).toBe(0)
  })

  it('shows conversations that mention the words below the sessions, leaves out sessions already listed by name, and offers all of them once there are more than fit', () => {
    const rows = [ws(`${HOME}/a`, [row('named', { title: 'login page' })])]
    const hit = (id: string, mtime = 0): SessionSearchHit => ({
      row: row(id, { mtime }),
      workspacePath: `${HOME}/a`,
      snippet: { before: '', match: 'login', after: '' }
    })
    const hits = [
      hit('named'),
      ...[1, 2, 3, 4].map((n) => hit(`c${n}`)),
      { ...hit('t'), snippet: undefined }
    ]
    const groups = paletteGroups(paletteSessions(rows, [], [], []), [], [], 'login', hits)
    expect(groups.map((g) => g.title)).toEqual(['Sessions', 'In conversations'])
    expect(groups[1].items.map((i) => i.key)).toEqual(['h:c1', 'h:c2', 'h:c3', 'more-hits'])
    expect(groups[1].items[3]).toMatchObject({ kind: 'more', count: hits.length })
  })
})

describe('command palette: @ names a workspace', () => {
  const rows = [
    ws(`${HOME}/koloft`, []),
    ws(`${HOME}/koloft-site`, []),
    ws(`${HOME}/my notes`, []),
    remote('build-box', '/srv/api', [])
  ]
  const items = paletteWorkspaces(rows, HOME)

  it('tags a local workspace by its folder name and a remote one as host:name; two that share a tag, in any case, go by their paths', () => {
    expect(items.map((i) => i.tag)).toEqual(['koloft', 'koloft-site', 'my notes', 'build-box:api'])
    const twins = paletteWorkspaces([ws(`${HOME}/a/App`, []), ws(`${HOME}/b/app`, [])], HOME)
    expect(twins.map((i) => i.tag)).toEqual(['~/a/App', '~/b/app'])
  })

  it('offers workspaces while the caret sits in a word that starts with @ — also right after Chinese text or inside a user@host — and never inside an email address or once a space is typed', () => {
    const at = (text: string, caret = text.length) => mentionTyping(text, caret)
    expect(at('fix @kol')).toMatchObject({ start: 4, end: 8, typed: 'kol' })
    expect(at('@')).toMatchObject({ start: 0, end: 1, typed: '' })
    expect(at('@kolxx bug', 4)).toMatchObject({ start: 0, end: 6, typed: 'kol', word: 'kolxx' })
    expect(at('帮@kol')).toMatchObject({ start: 1, typed: 'kol' })
    expect(at('@me@bo')).toMatchObject({ start: 0, typed: 'me@bo' })
    expect(at('mail me@kol')).toBeNull()
    expect(at('@koloft fix')).toBeNull()
    const offered = (text: string, caret = text.length) =>
      mentionCandidates(items, mentionTyping(text, caret)!).map((i) => i.tag)
    expect(offered('@KOL')).toEqual(['koloft', 'koloft-site'])
    expect(offered('@box')).toEqual(['build-box:api'])
  })

  it('offers nothing once the @ word already names a workspace in full, so ⏎ starts the work instead of filling in a longer name', () => {
    const offered = (text: string, caret = text.length) =>
      mentionCandidates(items, mentionTyping(text, caret)!).map((i) => i.tag)
    expect(offered('fix @koloft')).toEqual([])
    expect(offered('@koloft-site', 4)).toEqual([])
    expect(offered('@kolo')).toEqual(['koloft', 'koloft-site'])
  })

  it('a picked workspace replaces the whole @ word and leaves the caret after one space', () => {
    const text = 'fix @kolxx the bug'
    const at = mentionTyping(text, 8)!
    expect(completeMention(text, at, 'koloft')).toEqual({
      text: 'fix @koloft the bug',
      caret: 12
    })
    expect(completeMention('@k', mentionTyping('@k', 2)!, 'my notes')).toEqual({
      text: '@my notes ',
      caret: 10
    })
  })

  it('the first @ that names a whole workspace pins it, in any case, and is left out of the words sent on', () => {
    expect(pinnedWorkspace('@koloft fix the bug', items)).toEqual({
      wsPath: `${HOME}/koloft`,
      prompt: 'fix the bug'
    })
    expect(pinnedWorkspace('fix @Koloft-Site the\nfooter', items)).toEqual({
      wsPath: `${HOME}/koloft-site`,
      prompt: 'fix the\nfooter'
    })
    expect(pinnedWorkspace('fix the footer @koloft \nand the header', items)?.prompt).toBe(
      'fix the footer\nand the header'
    )
    expect(pinnedWorkspace('in @my notes tidy up', items)?.wsPath).toBe(`${HOME}/my notes`)
    expect(pinnedWorkspace('deploy @build-box:api', items)).toEqual({
      wsPath: 'ssh://build-box/srv/api',
      prompt: 'deploy'
    })
    expect(pinnedWorkspace('帮@koloft修一下', items)).toEqual({
      wsPath: `${HOME}/koloft`,
      prompt: '帮修一下'
    })
    expect(pinnedWorkspace('@koloft，修一下', items)?.wsPath).toBe(`${HOME}/koloft`)
    expect(pinnedWorkspace('@kol fix', items)).toBeNull()
    expect(pinnedWorkspace('me@koloft fix', items)).toBeNull()
  })

  it('every @ that names a whole workspace is found, so a second name can be told apart from a half-typed one', () => {
    expect(namedWorkspaces('@koloft fix it, and @Koloft-Site too', items)).toEqual([
      { start: 0, end: 7, wsPath: `${HOME}/koloft` },
      { start: 20, end: 32, wsPath: `${HOME}/koloft-site` }
    ])
    expect(namedWorkspaces('@koloft fix @kol', items)).toHaveLength(1)
  })
})
