import { describe, expect, it } from 'vitest'
import {
  digitPick,
  pickerRows,
  preselectIndex,
  pullable,
  rowNote,
  skipPicker
} from '../../src/renderer/src/workspacePicker'
import type { WorkspaceFreshness, WorkspaceRows } from '@shared/types'

const NOW = 1_700_000_000_000
const MIN = 60_000

const pullableFreshness = (patch: Partial<WorkspaceFreshness> = {}): WorkspaceFreshness => ({
  state: 'ok',
  behind: 3,
  ahead: 0,
  branch: 'main',
  head: 'a'.repeat(40),
  defRef: 'origin/main',
  onDefault: true,
  dirty: false,
  linked: false,
  hasSubmodules: false,
  fetchedAt: NOW - 2 * MIN,
  lastAttemptAt: NOW - 2 * MIN,
  ...patch
})

const ws = (path: string, patch: Partial<WorkspaceRows['workspace']> = {}): WorkspaceRows => ({
  workspace: {
    path,
    missing: false,
    isGit: true,
    hasHistory: false,
    ...patch
  },
  rows: []
})

describe('pickerRows (C10: which workspaces a mode offers, and the digit ⌘N answers each to)', () => {
  it('numbers every pinned workspace in array order in ⌘N mode', () => {
    const rows = pickerRows([ws('/a'), ws('/b'), ws('/c')], 'main')
    expect(rows.map((r) => [r.ws.workspace.path, r.digit])).toEqual([
      ['/a', 1],
      ['/b', 2],
      ['/c', 3]
    ])
  })

  it('hides a missing workspace in BOTH modes and renumbers what is left', () => {
    const rows = [ws('/a'), ws('/gone', { missing: true }), ws('/c')]
    expect(pickerRows(rows, 'main').map((r) => [r.ws.workspace.path, r.digit])).toEqual([
      ['/a', 1],
      ['/c', 2]
    ])
    expect(pickerRows(rows, 'worktree').map((r) => [r.ws.workspace.path, r.digit])).toEqual([
      ['/a', 1],
      ['/c', 2]
    ])
  })

  it('keeps a non-git workspace in ⌘N mode (cwd = the folder itself, D10)', () => {
    const rows = pickerRows([ws('/plain', { isGit: false }), ws('/repo')], 'main')
    expect(rows.map((r) => r.ws.workspace.path)).toEqual(['/plain', '/repo'])
  })

  it('hides non-git workspaces in ⇧⌘N mode and renumbers by what is visible (D10)', () => {
    const rows = pickerRows([ws('/plain', { isGit: false }), ws('/a'), ws('/b')], 'worktree')
    expect(rows.map((r) => [r.ws.workspace.path, r.digit])).toEqual([
      ['/a', 1],
      ['/b', 2]
    ])
  })

  it('gives the tenth visible row and beyond no digit at all (↓↑ only)', () => {
    const rows = pickerRows(
      Array.from({ length: 11 }, (_, i) => ws(`/w${i}`)),
      'main'
    )
    expect(rows).toHaveLength(11)
    expect(rows[8].digit).toBe(9)
    expect(rows[9].digit).toBeNull()
    expect(rows[10].digit).toBeNull()
  })

  it('offers nothing when every pinned workspace is filtered out', () => {
    expect(pickerRows([ws('/gone', { missing: true })], 'main')).toEqual([])
    expect(pickerRows([ws('/plain', { isGit: false })], 'worktree')).toEqual([])
  })
})

describe('preselectIndex (the last-touched chain, over THIS mode’s rows)', () => {
  it('preselects the last-touched workspace', () => {
    expect(preselectIndex([ws('/a'), ws('/b')], 'main', '/b')).toBe(1)
  })

  it('falls back to the first visible row when nothing was ever touched', () => {
    expect(preselectIndex([ws('/a'), ws('/b')], 'main', null)).toBe(0)
  })

  it('falls through to the first visible row when the last-touched one is hidden here (rev3)', () => {
    const rows = [ws('/plain', { isGit: false }), ws('/a'), ws('/b')]
    expect(preselectIndex(rows, 'main', '/plain')).toBe(0)
    expect(preselectIndex(rows, 'worktree', '/plain')).toBe(0)
    expect(pickerRows(rows, 'worktree')[0].ws.workspace.path).toBe('/a')
  })

  it('never points at a hidden row when the last-touched folder vanished', () => {
    expect(preselectIndex([ws('/gone', { missing: true }), ws('/a')], 'main', '/gone')).toBe(0)
  })

  it('is 0 with nothing to point at', () => {
    expect(preselectIndex([], 'main', null)).toBe(0)
  })
})

describe('pullable (D3: the one freshness state ⌘N reacts to)', () => {
  it('is true for a clean main checkout that is purely behind', () => {
    expect(pullable(ws('/a', { freshness: pullableFreshness() }))).toBe(true)
  })

  it('is false for every other state — unmeasured, dirty, diverged, offline (D14)', () => {
    expect(pullable(ws('/a'))).toBe(false)
    expect(pullable(ws('/a', { freshness: pullableFreshness({ dirty: true }) }))).toBe(false)
    expect(pullable(ws('/a', { freshness: pullableFreshness({ ahead: 2 }) }))).toBe(false)
    expect(pullable(ws('/a', { freshness: pullableFreshness({ state: 'error' }) }))).toBe(false)
    expect(pullable(ws('/a', { freshness: pullableFreshness({ behind: 0 }) }))).toBe(false)
  })
})

describe('skipPicker (when the picker gets out of the way — forked by mode)', () => {
  it('skips a single up-to-date workspace in ⌘N mode', () => {
    expect(skipPicker([ws('/a')], 'main')).toBe(true)
  })

  it('does NOT skip a single behind-and-pullable one — that is the D6a gate', () => {
    expect(skipPicker([ws('/a', { freshness: pullableFreshness() })], 'main')).toBe(false)
  })

  it('skips a single behind-but-not-pullable one: ⌘N launches instantly (D14)', () => {
    expect(skipPicker([ws('/a', { freshness: pullableFreshness({ dirty: true }) })], 'main')).toBe(
      true
    )
  })

  it('skips unconditionally in ⇧⌘N mode — the confirm there opens C8, not a session', () => {
    expect(skipPicker([ws('/a', { freshness: pullableFreshness() })], 'worktree')).toBe(true)
  })

  it('never skips with two visible rows, however fresh they are', () => {
    expect(skipPicker([ws('/a'), ws('/b')], 'main')).toBe(false)
    expect(skipPicker([ws('/a'), ws('/b')], 'worktree')).toBe(false)
  })

  it('counts only the rows the mode shows', () => {
    const rows = [ws('/plain', { isGit: false }), ws('/a')]
    expect(skipPicker(rows, 'worktree')).toBe(true)
    expect(skipPicker(rows, 'main')).toBe(false)
  })

  it('does not skip when there is nothing to skip TO (the caller toasts instead)', () => {
    expect(skipPicker([], 'main')).toBe(false)
    expect(skipPicker([ws('/plain', { isGit: false })], 'worktree')).toBe(false)
  })
})

describe('digitPick (a digit is a row number, bounds-checked)', () => {
  const rows = pickerRows([ws('/a'), ws('/b')], 'main')

  it('maps the digit onto the visible row it prints', () => {
    expect(digitPick(rows, 1)).toBe(0)
    expect(digitPick(rows, 2)).toBe(1)
  })

  it('ignores a digit past the last row — the picker stays open (BB-C15)', () => {
    expect(digitPick(rows, 3)).toBeNull()
  })

  it('ignores 0, and any digit no row prints (row 10 has none)', () => {
    expect(digitPick(rows, 0)).toBeNull()
    const ten = pickerRows(
      Array.from({ length: 10 }, (_, i) => ws(`/w${i}`)),
      'main'
    )
    expect(digitPick(ten, 9)).toBe(8)
    expect(digitPick(ten, 10)).toBeNull()
  })
})

describe('rowNote (§03A: the sidebar’s own badge, then the short path)', () => {
  const HOME = '/Users/kim'

  it('is the abbreviated path alone for a healthy git workspace', () => {
    expect(rowNote(ws(HOME + '/Projects/app'), HOME, NOW)).toBe('~/Projects/app')
  })

  it('prefixes how far behind the workspace is', () => {
    expect(
      rowNote(ws(HOME + '/nb', { freshness: pullableFreshness({ behind: 3 }) }), HOME, NOW)
    ).toBe('behind 3 · ~/nb')
  })

  it('prefixes `no git` for a plain folder', () => {
    expect(rowNote(ws(HOME + '/notes', { isGit: false }), HOME, NOW)).toBe('no git · ~/notes')
  })

  it('says nothing about a workspace that is level with origin', () => {
    expect(
      rowNote(ws(HOME + '/koloft', { freshness: pullableFreshness({ behind: 0 }) }), HOME, NOW)
    ).toBe('~/koloft')
  })

  it('leaves a path outside home alone (and never eats a sibling of home)', () => {
    expect(rowNote(ws('/opt/src'), HOME, NOW)).toBe('/opt/src')
    expect(rowNote(ws(HOME + '-old/x'), HOME, NOW)).toBe(HOME + '-old/x')
  })
})
