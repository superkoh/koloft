import { describe, it, expect } from 'vitest'
import type { WorkspaceRows } from '../../src/shared/types'
import {
  clampNotesHeight,
  isOrphanRow,
  marqueeAnim,
  mixesBackends,
  paneWidthFromDrag,
  currentWorkspace,
  notesHeightFromDrag,
  parkedBadge,
  sessionActivityBadge,
  relTime,
  rowStateClass,
  selectionRoot,
  welcomeQuietLine,
  welcomeTarget
} from '../../src/renderer/src/sessionRows'

describe('relTime (cold menu header / tooltip)', () => {
  const now = 100_000_000_000

  it('buckets seconds / minutes / hours / days at their contract thresholds, flooring rather than rounding up', () => {
    expect(relTime(now - 5_000, now)).toBe('5s ago')
    expect(relTime(now - 59_000, now)).toBe('59s ago')
    expect(relTime(now - 60_000, now)).toBe('1m ago')
    expect(relTime(now - 90_000, now)).toBe('1m ago')
    expect(relTime(now - 2 * 3_600_000, now)).toBe('2h ago')
    expect(relTime(now - 2 * 86_400_000, now)).toBe('2d ago')
  })

  it('clamps a future mtime (clock skew) to 0s ago instead of negative time', () => {
    expect(relTime(now + 5_000, now)).toBe('0s ago')
  })

  it('always matches the pinned display format', () => {
    for (const t of [now - 1_000, now - 61_000, now - 3_700_000, now - 90_000_000]) {
      expect(relTime(t, now)).toMatch(/^\d+[smhd] ago$/)
    }
  })
})

describe('rowStateClass (C2 lightbar)', () => {
  it('maps each running run-state onto its st-* lightbar class', () => {
    expect(rowStateClass(true, 'working')).toBe('st-working')
    expect(rowStateClass(true, 'waiting')).toBe('st-waiting')
    expect(rowStateClass(true, 'approval')).toBe('st-approval')
    expect(rowStateClass(true, 'idle')).toBe('st-idle')
  })

  it('treats a bound-but-statusless running session as idle (logic.md §4)', () => {
    expect(rowStateClass(true, undefined)).toBe('st-idle')
  })

  it('cold rows carry no bar class — just cold', () => {
    expect(rowStateClass(false, undefined)).toBe('cold')
    expect(rowStateClass(false, 'working')).toBe('cold')
  })

  it('a pending launch reads as st-pending, never cold, so it never invites a resume click (logic.md §4)', () => {
    expect(rowStateClass(false, undefined, true)).toBe('st-pending')
    expect(rowStateClass(false, 'working', true)).toBe('st-pending')
  })

  it('keeps running rows on their run-state once the pending flag clears', () => {
    expect(rowStateClass(true, 'working', false)).toBe('st-working')
  })
})

describe('marqueeAnim (C2 hover marquee)', () => {
  it('does not arm for a title that fits', () => {
    expect(marqueeAnim(0)).toBeNull()
    expect(marqueeAnim(-12)).toBeNull()
  })

  it('scrolls exactly the measured overflow, no fixed distance, holding at the end rather than snapping back', () => {
    const a = marqueeAnim(240)
    expect(a?.frames[0].transform).toBe('translateX(0px)')
    expect(a?.frames[1].transform).toBe('translateX(-240px)')
    expect(a?.frames[2].transform).toBe('translateX(-240px)')
  })

  it('keeps the scroll speed constant — twice the overflow takes twice as long', () => {
    const a = marqueeAnim(600)
    const b = marqueeAnim(1200)
    const scrollA = a!.timing.duration - 700
    const scrollB = b!.timing.duration - 700
    expect(scrollB).toBeCloseTo(scrollA * 2, 5)
  })

  it('holds 0.7s at the tail and starts 0.5s after hover', () => {
    const a = marqueeAnim(600)!
    expect(a.timing.delay).toBe(500)
    expect(a.timing.iterations).toBe(Infinity)
    expect(a.timing.easing).toBe('linear')
    const tailMs = a.timing.duration * (1 - a.frames[1].offset)
    expect(tailMs).toBeCloseTo(700, 5)
  })

  it('floors the scroll time so a barely-overflowing title is still readable', () => {
    const a = marqueeAnim(3)!
    expect(a.timing.duration - 700).toBeGreaterThanOrEqual(600)
  })
})

describe('welcomeTarget (S4 panel / O2)', () => {
  const ws = (path: string, missing = false): WorkspaceRows => ({
    workspace: { path, missing, isGit: true, hasHistory: false },
    rows: []
  })

  it('is null with nothing pinned — the panel degrades to "No workspace yet"', () => {
    expect(welcomeTarget([], null)).toBeNull()
    expect(welcomeTarget([], '/a')).toBeNull()
  })

  it('falls back to the first workspace when nothing was selected yet (restart)', () => {
    expect(welcomeTarget([ws('/a'), ws('/b')], null)?.workspace.path).toBe('/a')
  })

  it('shows the last selected workspace while it is still pinned', () => {
    expect(welcomeTarget([ws('/a'), ws('/b')], '/b')?.workspace.path).toBe('/b')
  })

  it('falls back when the remembered workspace was removed or vanished', () => {
    expect(welcomeTarget([ws('/a'), ws('/b')], '/gone')?.workspace.path).toBe('/a')
    expect(welcomeTarget([ws('/a', true), ws('/b')], '/a')?.workspace.path).toBe('/b')
  })

  it('is null when every pinned folder is gone', () => {
    expect(welcomeTarget([ws('/a', true)], '/a')).toBeNull()
  })
})

describe('currentWorkspace (the Notes island’s workspace)', () => {
  const ws = (path: string, ids: string[] = [], missing = false): WorkspaceRows => ({
    workspace: { path, missing, isGit: true, hasHistory: false },
    rows: ids.map((id) => ({
      id,
      title: id,
      worktree: 'main',
      cwd: path,
      running: true,
      invalidCwd: false,
      mtime: 0
    }))
  })
  const rows = [ws('/a', ['s1']), ws('/b', ['s2'])]

  it('follows the picked session to the workspace its row is listed under', () => {
    expect(currentWorkspace(rows, 's1', null, null)).toBe('/a')
    expect(currentWorkspace(rows, 's2', null, null)).toBe('/b')
  })

  it('gives a worktree session its PARENT workspace — that is where the note lives', () => {
    const parent = ws('/a', ['s1', 'wt-1'])
    expect(currentWorkspace([parent, ws('/b')], 'wt-1', null, null)).toBe('/a')
  })

  it('takes the picked workspace head when no session is picked (D7)', () => {
    expect(currentWorkspace(rows, null, '/b', '/a')).toBe('/b')
  })

  it('falls back to the welcome panel’s workspace when nothing is picked at all', () => {
    expect(currentWorkspace(rows, null, null, '/b')).toBe('/b')
    expect(currentWorkspace(rows, null, null, null)).toBe('/a')
  })

  it('never lands on a folder that is gone, from any of the three doors', () => {
    const gone = [ws('/a', ['s1'], true), ws('/b', ['s2'])]
    expect(currentWorkspace(gone, 's1', null, null)).toBe('/b')
    expect(currentWorkspace(gone, null, '/a', null)).toBe('/b')
    expect(currentWorkspace(gone, null, null, '/a')).toBe('/b')
  })

  it('is null with nothing pinned — then the island is not in the dock at all (D3)', () => {
    expect(currentWorkspace([], null, null, null)).toBeNull()
    expect(currentWorkspace([], 's1', '/a', '/a')).toBeNull()
  })
})

describe('notesHeightFromDrag (the dock gutter)', () => {
  const drag = (y: number): number => notesHeightFromDrag(740, 700, y)

  it('grows the note as the gutter is pulled UP — it is the bottom island', () => {
    expect(drag(500)).toBe(240)
    expect(drag(440)).toBe(300)
    expect(drag(600)).toBeLessThan(drag(500))
  })

  it('never goes under the note’s own floor', () => {
    expect(drag(700)).toBe(120)
    expect(drag(900)).toBe(120)
  })

  it('always leaves the sessions island 160px plus the gutter', () => {
    expect(drag(0)).toBe(700 - 160 - 10)
    expect(drag(-500)).toBe(530)
  })

  it('keeps the floor even in a window too short to honour both clamps', () => {
    expect(notesHeightFromDrag(240, 200, 0)).toBe(120)
  })
})

describe('clampNotesHeight (the remembered height, in THIS window: a height saved on a big display must not squeeze the sessions island away)', () => {
  it('hands a height the dock can hold straight back', () => {
    expect(clampNotesHeight(260, 700)).toBe(260)
  })

  it('cuts a height from a bigger display down to what leaves the sessions list its floor', () => {
    expect(clampNotesHeight(600, 500)).toBe(500 - 160 - 10)
  })

  it('lifts a height under the note’s own floor back up to it', () => {
    expect(clampNotesHeight(40, 700)).toBe(120)
  })

  it('keeps the floor in a dock too short for both — a ceiling under the floor is none', () => {
    expect(clampNotesHeight(600, 200)).toBe(120)
  })
})

describe('selectionRoot (Files island root / a terminal tab’s cwd)', () => {
  const claude = { kind: 'claude' as const, cwd: '/repo' }

  it('roots a bound session at ITS cwd, not the launch cwd', () => {
    expect(selectionRoot(claude, '/repo/.claude/worktrees/feat', '/ws')).toBe(
      '/repo/.claude/worktrees/feat'
    )
  })

  it('roots an unbound claude tab at its launch cwd until the session reports', () => {
    expect(selectionRoot(claude, undefined, '/ws')).toBe('/repo')
  })

  it('falls back to the welcome workspace with no tab selected (O2)', () => {
    expect(selectionRoot(undefined, undefined, '/ws')).toBe('/ws')
  })

  it('falls back for a shell tab too — only a session carries a scope of its own', () => {
    expect(selectionRoot({ kind: 'shell', cwd: '/somewhere' }, undefined, '/ws')).toBe('/ws')
  })

  it('is null with neither a session nor a pinned workspace', () => {
    expect(selectionRoot(undefined, undefined, undefined)).toBeNull()
    expect(selectionRoot({ kind: 'shell', cwd: '/somewhere' }, undefined, undefined)).toBeNull()
  })
})

describe('paneWidthFromDrag (right-side aux pane, gutter on its left edge)', () => {
  it('width follows the mouse: pane right edge minus pointer x', () => {
    expect(paneWidthFromDrag(1000, 100, 550)).toBe(450)
  })

  it('dragging RIGHT shrinks the pane (the mirrored-direction guard)', () => {
    expect(paneWidthFromDrag(1000, 100, 600)).toBeLessThan(paneWidthFromDrag(1000, 100, 500))
  })

  it('clamps to the 320px floor', () => {
    expect(paneWidthFromDrag(1000, 100, 900)).toBe(320)
  })

  it('ceiling leaves the TUI its 360px (+20 chrome) between dock and pane', () => {
    expect(paneWidthFromDrag(1000, 100, 200)).toBe(520)
  })
})

describe('isOrphanRow (a running row this renderer cannot open, as after a reload drops every tab while main keeps the ptys)', () => {
  const row = { id: 'sess-1', running: true }
  const freshLaunchTab = { id: 'pty-1', alive: true }
  const resumeTab = { id: 'pty-9', sessionId: 'sess-1', alive: true }
  const stream = [{ sessionId: 'sess-1', tabId: 'pty-1', alive: true }]

  it('says no while the tab the stream names is here', () => {
    expect(isOrphanRow(row, stream, [freshLaunchTab])).toBe(false)
  })

  it('says no when only the tab’s own session id links it, since the push-only stream can lag', () => {
    expect(isOrphanRow(row, [], [resumeTab])).toBe(false)
  })

  it('says yes when both sources miss', () => {
    expect(isOrphanRow(row, [], [])).toBe(true)
  })

  it('says yes when the stream still names a tab this renderer no longer has', () => {
    expect(isOrphanRow(row, stream, [])).toBe(true)
  })

  it('says yes when the only tab carrying the id has exited', () => {
    expect(isOrphanRow(row, [], [{ ...resumeTab, alive: false }])).toBe(true)
    expect(isOrphanRow(row, stream, [{ ...freshLaunchTab, alive: false }])).toBe(true)
  })

  it('ignores another session’s live tab', () => {
    expect(isOrphanRow(row, [], [{ id: 'pty-2', sessionId: 'sess-2', alive: true }])).toBe(true)
  })

  it('never fires on a cold row — resume owns that click, tab or no tab', () => {
    const cold = { id: 'sess-1', running: false }
    expect(isOrphanRow(cold, stream, [freshLaunchTab])).toBe(false)
    expect(isOrphanRow(cold, [], [])).toBe(false)
  })

  it('does not read a dead stream entry as a reachable tab', () => {
    expect(
      isOrphanRow(row, [{ sessionId: 'sess-1', tabId: 'pty-1', alive: false }], [freshLaunchTab])
    ).toBe(true)
  })
})

describe('parkedBadge', () => {
  it('counts every parked thing (a teammate entry counts as many), names each for the card, and says how to release them', () => {
    const b = parkedBadge([
      { kind: 'server', label: 'python3 -m http.server 4179', ageMs: 3 * 3600_000 },
      { kind: 'monitor', label: 'tail -f bot.log' },
      { kind: 'teammate', label: '12 idle' }
    ])
    expect(b.text).toBe('⏸ 14')
    expect(b.lines).toEqual([
      'server · python3 -m http.server 4179 · running 3h',
      'monitor · tail -f bot.log',
      '12 teammates idle'
    ])
    expect(b.hint).toMatch(/ctrl\+b/)
  })
})

describe('welcomeQuietLine', () => {
  it('says nothing is running when nothing is', () => {
    expect(welcomeQuietLine(0)).toBe('No running session')
  })

  it('counts one session in the singular', () => {
    expect(welcomeQuietLine(1)).toBe('1 session running — pick one on the left')
  })

  it('counts several in the plural', () => {
    expect(welcomeQuietLine(3)).toBe('3 sessions running — pick one on the left')
  })
})

describe('session background activity', () => {
  it('reports unavailable observation without presenting stale background work as current', () => {
    const badge = sessionActivityBadge({
      backendId: 'codex',
      observation: 'degraded',
      background: [{ id: 'a1', kind: 'agent', label: 'Review', state: 'working' }]
    })!
    expect(badge.heading).toBe('Status unavailable')
    expect(badge.lines.join(' ')).toContain('may still be running')
    expect(badge.lines.join(' ')).not.toContain('Review · working')
    expect(badge.hint).toContain('terminal')
  })

  it('names unknown commands without treating them as idle servers', () => {
    const badge = sessionActivityBadge({
      backendId: 'codex',
      background: [{ id: 'c1', kind: 'command', label: 'npm run build', state: 'unknown' }]
    })!
    expect(badge.heading).toBe('Background activity')
    expect(badge.text).toContain('?')
    expect(badge.lines).toEqual(['command · npm run build · state unknown'])
    expect(badge.hint).toContain('may still be running')
    expect(badge.lines.join(' ')).not.toMatch(/idle|server/)
  })

  it('reports agents and commands with their distinct states', () => {
    const badge = sessionActivityBadge({
      background: [
        { id: 'a1', kind: 'agent', label: 'Review changes', state: 'working' },
        { id: 'a2', kind: 'agent', label: 'Check tests', state: 'waiting' },
        { id: 'c1', kind: 'command', label: 'Build', state: 'unknown' }
      ]
    })!
    expect(badge.lines).toEqual([
      'agent · Review changes · working',
      'agent · Check tests · waiting',
      'command · Build · state unknown'
    ])
    expect(badge.text).toContain('3')
    expect(badge.hint).toContain('Unknown')
  })

  it('keeps known parked services visible alongside background activity', () => {
    const parked = [{ kind: 'server' as const, label: 'dev server' }]
    expect(sessionActivityBadge({ parked })?.lines).toEqual(parkedBadge(parked).lines)
    const badge = sessionActivityBadge({
      parked,
      background: [{ id: 'a1', kind: 'agent', label: 'Review', state: 'working' }]
    })!
    expect(badge.lines).toContain('server · dev server')
    expect(sessionActivityBadge({})).toBeNull()
  })
})

describe('mixesBackends (when a row list shows method icons)', () => {
  it('stays off for a list of Claude rows, tagged or not', () => {
    expect(mixesBackends([{}, {}])).toBe(false)
    expect(mixesBackends([{ backendId: 'claude' }, {}])).toBe(false)
  })

  it('turns on as soon as one list holds both methods', () => {
    expect(mixesBackends([{ backendId: 'claude' }, { backendId: 'codex' }])).toBe(true)
  })

  it('stays off for Codex rows alone — a lone icon has nothing to contrast with', () => {
    expect(mixesBackends([{ backendId: 'codex' }])).toBe(false)
  })
})
