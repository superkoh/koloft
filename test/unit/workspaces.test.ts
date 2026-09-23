import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { execFileSync } from 'child_process'
import { WorkspaceManager, type LiveSession } from '../../src/main/workspaces'
import { projectInfoFor } from '../../src/main/projectInfo'
import { encodeCwd } from '../../src/main/sessionTracker'
import {
  PENDING_SESSION_TITLE,
  type LayoutV4,
  type SessionWorkbenchState,
  type WorkspaceRows
} from '@shared/types'

// The manager is the IO half of the aggregation: what it PUSHES is the sidebar's whole
// truth. Two things only it can get wrong — the per-workspace isGit probe, and the
// pending-launch lifecycle (hold → promote → drop) that spans a rescan boundary.
// Everything else is injected, so this drives it with a temp Claude storage tree.

let root: string
let projectsRoot: string
let repo: string
let plain: string
let layout: LayoutV4
let bindings: Map<string, string>
let pushed: WorkspaceRows[][]
let saves: number
let mgr: WorkspaceManager

/** the shipped default panel state — collapsed (`DEFAULT_PANEL_OPEN`, which this suite's
 *  layout spells out as `workbench.defaultOpen: false`) and no tabs, since `files` is
 *  implied rather than stored (FR-02). What a hook bind seeds and what a session with no
 *  entry of its own reads back. */
const SEEDED: SessionWorkbenchState = { open: false, tabs: [] }

function writeJsonl(cwd: string, id: string, timestamp = '2026-08-08T11:00:00.000Z'): void {
  const dir = path.join(projectsRoot, encodeCwd(cwd))
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, id + '.jsonl'),
    JSON.stringify({ type: 'summary', summary: 'a session' }) +
      '\n' +
      JSON.stringify({ type: 'user', cwd, timestamp, sessionId: id }) +
      '\n'
  )
}

function setMtime(cwd: string, id: string, epochSec: number): void {
  const f = path.join(projectsRoot, encodeCwd(cwd), id + '.jsonl')
  fs.utimesSync(f, epochSec, epochSec)
}

/** A real repo with a real linked worktree — `git worktree list` is the only source
 *  of the second bucket, so the fake `.git` marker the other tests use can't reach it. */
function gitRepoWithWorktree(name: string): { repoDir: string; wtDir: string } {
  const repoDir = path.join(root, 'gitrepo')
  const git = (...args: string[]): void => {
    execFileSync('git', ['-C', repoDir, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
      stdio: 'ignore'
    })
  }
  execFileSync('git', ['init', '-q', repoDir], { stdio: 'ignore' })
  git('commit', '--allow-empty', '-q', '-m', 'init')
  const wtDir = path.join(repoDir, '.claude', 'worktrees', name)
  git('worktree', 'add', '-q', '-b', 'worktree-' + name, wtDir)
  return { repoDir, wtDir }
}

/** rows of the most recent push for one workspace */
function latest(wsPath: string): WorkspaceRows {
  const last = pushed[pushed.length - 1]
  const entry = last?.find((e) => e.workspace.path === wsPath)
  if (!entry) throw new Error(`no push carrying ${wsPath} yet`)
  return entry
}

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-wsmgr-')))
  projectsRoot = path.join(root, 'projects')
  repo = path.join(root, 'repo')
  plain = path.join(root, 'plain')
  fs.mkdirSync(projectsRoot)
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true })
  fs.mkdirSync(plain)
  layout = {
    version: 4,
    workspaces: [{ path: repo }, { path: plain }],
    workbench: { defaultOpen: false },
    sessions: {}
  }
  bindings = new Map()
  pushed = []
  saves = 0
  mgr = new WorkspaceManager({
    projectsRoot,
    remoteProjectsRoot: (host: string) => path.join(root, 'remote', host, 'projects'),
    loadLayout: () => layout,
    saveLayout: (l) => {
      saves++
      layout = l
    },
    projectInfo: projectInfoFor,
    runningBindings: () => bindings,
    killTab: () => {},
    pushRows: (p) => pushed.push(p)
  })
})

describe('pinned paths before the first rescan', () => {
  // The freshness engine's startup sweep fires 3s in and its focus sweep can fire even
  // earlier; both used to read rows(), which is empty until a rescan lands, so the whole
  // round silently no-op'd. The pin list comes off the layout, which is loaded in the
  // constructor — it never needs a rescan to be true.
  it('lists every pin, with missing derived, before rows() has anything', () => {
    expect(mgr.rows()).toEqual([])
    expect(mgr.pinnedPaths()).toEqual([
      { path: repo, missing: false },
      { path: plain, missing: false }
    ])
  })

  it('marks a pin whose directory is gone as missing', () => {
    fs.rmSync(plain, { recursive: true, force: true })
    expect(mgr.pinnedPaths()).toEqual([
      { path: repo, missing: false },
      { path: plain, missing: true }
    ])
  })
})

afterEach(() => {
  mgr.dispose()
  fs.rmSync(root, { recursive: true, force: true })
})

describe('WorkspaceManager: isGit', () => {
  it('flags each pinned workspace by its own .git marker', async () => {
    mgr.start()
    await vi.waitFor(() => expect(pushed.length).toBeGreaterThan(0))
    expect(latest(repo).workspace).toEqual({
      path: repo,
      missing: false,
      isGit: true,
      hasHistory: false
    })
    expect(latest(plain).workspace).toEqual({
      path: plain,
      missing: false,
      isGit: false,
      hasHistory: false
    })
  })
})

describe('WorkspaceManager: freshness stamping', () => {
  it('reads the engine at the moment it writes the rows, for every workspace', async () => {
    // a rescan awaits git per workspace; an engine apply landing in one of those windows
    // must not be overwritten by the values the loop read before it. The GC's saveLayout
    // is the one hook that fires after the loop and before the push — it stands in for
    // that apply, and both workspaces must carry the value it left behind.
    const base = {
      state: 'ok' as const,
      ahead: 0,
      branch: 'main',
      head: 'a'.repeat(40),
      defRef: 'origin/main',
      onDefault: true,
      dirty: false,
      linked: false,
      hasSubmodules: false,
      fetchedAt: 1,
      lastAttemptAt: 1
    }
    let behind = 0
    layout.sessions = { ghost: SEEDED } // no jsonl → GC writes
    mgr.dispose()
    mgr = new WorkspaceManager({
      projectsRoot,
      remoteProjectsRoot: (host: string) => path.join(root, 'remote', host, 'projects'),
      loadLayout: () => layout,
      saveLayout: (l) => {
        layout = l
        behind = 7 // the engine applied a fresh measurement mid-rescan
      },
      projectInfo: projectInfoFor,
      runningBindings: () => bindings,
      killTab: () => {},
      pushRows: (p) => pushed.push(p),
      freshness: () => ({ ...base, behind })
    })
    mgr.start()
    await vi.waitFor(() => expect(pushed.length).toBeGreaterThan(0))
    expect(latest(repo).workspace.freshness?.behind).toBe(7)
    expect(latest(plain).workspace.freshness?.behind).toBe(7)
  })
})

describe('WorkspaceManager: owned-only sidebar (decided 2026-08-09)', () => {
  it('an external jsonl stays invisible until its session is bound once', async () => {
    writeJsonl(repo, 'ext-1')
    mgr.start()
    await vi.waitFor(() => expect(pushed.length).toBeGreaterThan(0))
    expect(latest(repo).rows).toEqual([])
    // (D1 backfill dropped): a rescan never adopts — ownership comes only
    // from the v1-tab migration seed or a live hook bind, so the table must not
    // grow behind the filter's back either
    expect(layout.sessions['ext-1']).toBeUndefined()

    // a resume (or a future import) binds it once — owned from then on, persistently
    mgr.onSessionBound('ext-1')
    await vi.waitFor(() => expect(latest(repo).rows.map((r) => r.id)).toEqual(['ext-1']))
    expect(layout.sessions['ext-1']).toEqual(SEEDED)
  })
})

describe('WorkspaceManager: cold-row title parity with the live tracker', () => {
  // The tracker titles a LIVE session sidecar-first (`<id>.title`, written by an
  // external AI-title generator); the cold aggregation used to ignore the sidecar,
  // so a restart demoted every row to its jsonl-head title until re-activation.
  it('prefers the `<id>.title` sidecar over the jsonl-head title', async () => {
    writeJsonl(repo, 's1') // head carries summary "a session"
    fs.writeFileSync(path.join(projectsRoot, encodeCwd(repo), 's1.title'), 'Fresh AI name\n')
    layout.sessions['s1'] = SEEDED
    mgr.start()
    await vi.waitFor(() => expect(latest(repo).rows.map((r) => r.title)).toEqual(['Fresh AI name']))
  })
})

describe('WorkspaceManager: orphan worktree bucket (D2)', () => {
  // Bug 2 end to end through real git: claude removed its unchanged worktree at exit
  // (dir AND registration), the transcript survived — the OWNED session must come
  // back as a greyed row (invalidCwd), not vanish (§4 decision: never hide; D2 orphan bucket).
  it('shows an owned session whose worktree was removed as a greyed row under its old name', async () => {
    const { repoDir, wtDir } = gitRepoWithWorktree('bugfix')
    writeJsonl(wtDir, 'wt-1')
    execFileSync('git', ['-C', repoDir, 'worktree', 'remove', wtDir], { stdio: 'ignore' })
    mgr.dispose()
    layout = {
      ...layout,
      workspaces: [{ path: repoDir }],
      // ownership seeded the only ways it can be since the decision killed
      // the D1 backfill: a v1-tab migration seed or a live hook bind
      sessions: { 'wt-1': SEEDED }
    }
    mgr = new WorkspaceManager({
      projectsRoot,
      remoteProjectsRoot: (host: string) => path.join(root, 'remote', host, 'projects'),
      loadLayout: () => layout,
      saveLayout: (l) => {
        layout = l
      },
      projectInfo: projectInfoFor,
      runningBindings: () => bindings,
      killTab: () => {},
      pushRows: (p) => pushed.push(p)
    })
    mgr.start()
    await vi.waitFor(() =>
      expect(latest(repoDir).rows).toMatchObject([
        { id: 'wt-1', worktree: 'bugfix', cwd: wtDir, running: false, invalidCwd: true }
      ])
    )
  })
})

describe('WorkspaceManager: transcript bucket origin (§1✎)', () => {
  // the resume-start axis: which slug the transcript sits in, which the SessionRow
  // contract deliberately does not carry (the planner reads it from here instead)
  it('reports the bucket dir each session was aggregated from', async () => {
    const { repoDir, wtDir } = gitRepoWithWorktree('slugaxis')
    writeJsonl(repoDir, 'root-1')
    writeJsonl(wtDir, 'wt-1')
    mgr.dispose()
    layout = { ...layout, workspaces: [{ path: repoDir }] }
    mgr = new WorkspaceManager({
      projectsRoot,
      remoteProjectsRoot: (host: string) => path.join(root, 'remote', host, 'projects'),
      loadLayout: () => layout,
      saveLayout: (l) => {
        layout = l
      },
      projectInfo: projectInfoFor,
      runningBindings: () => bindings,
      killTab: () => {},
      pushRows: (p) => pushed.push(p)
    })
    mgr.start()
    await vi.waitFor(() => expect(mgr.findRow('wt-1')).toBeDefined())
    expect(mgr.bucketDirOf('root-1')).toBe(repoDir)
    expect(mgr.bucketDirOf('wt-1')).toBe(wtDir)
    expect(mgr.bucketDirOf('never-seen')).toBeUndefined()
  })
})

describe('WorkspaceManager: archive (decided 2026-08-09 — Close session retired)', () => {
  it('archiving a cold session deregisters it; the jsonl is untouched', async () => {
    writeJsonl(repo, 'done-1')
    layout.sessions['done-1'] = SEEDED
    mgr.start()
    await vi.waitFor(() => expect(latest(repo).rows.map((r) => r.id)).toEqual(['done-1']))

    expect(mgr.archiveSession('done-1')).toBe(true)
    await vi.waitFor(() => expect(latest(repo).rows).toEqual([]))
    expect(layout.sessions['done-1']).toBeUndefined()
    expect(fs.existsSync(path.join(projectsRoot, encodeCwd(repo), 'done-1.jsonl'))).toBe(true)
  })

  it('refuses to archive a live (bound) session', async () => {
    writeJsonl(repo, 'live-1')
    layout.sessions['live-1'] = SEEDED
    bindings.set('live-1', 'tab-9')
    mgr.start()
    await vi.waitFor(() => expect(latest(repo).rows.map((r) => r.id)).toEqual(['live-1']))

    expect(mgr.archiveSession('live-1')).toBe(false)
    expect(layout.sessions['live-1']).toBeDefined()
  })
})

describe('WorkspaceManager: pending launches', () => {
  it('holds a pending row until the session materializes, then swaps it in place', async () => {
    writeJsonl(repo, 'old-one')
    layout.sessions['old-one'] = SEEDED // Koloft-owned history
    mgr.start()
    await vi.waitFor(() => expect(latest(repo).rows).toHaveLength(1))

    mgr.launchStarted('tab-1', repo)
    await vi.waitFor(() => {
      const rows = latest(repo).rows
      expect(rows).toHaveLength(2)
      // pending sits above the cold history
      expect(rows[0]).toMatchObject({
        id: 'tab-1',
        title: PENDING_SESSION_TITLE,
        worktree: 'main',
        pending: true,
        running: false
      })
    })
    // it belongs to the workspace it was launched in, and nowhere else
    expect(latest(plain).rows).toEqual([])

    // SessionStart bound the tab and Claude wrote the transcript → real row takes over
    // (the bind also seeds ownership — index.ts calls onSessionBound on every bind)
    writeJsonl(repo, 'new-one', '2026-08-08T12:00:00.000Z')
    bindings.set('new-one', 'tab-1')
    mgr.onSessionBound('new-one')
    mgr.onTrackerUpdate()
    await vi.waitFor(() => {
      const rows = latest(repo).rows
      expect(rows.map((r) => r.id)).toEqual(['new-one', 'old-one'])
      expect(rows.some((r) => r.pending)).toBe(false)
    })

    // the launch is over for good: losing the binding (claude exited, tab untracked)
    // must not resurrect a "Starting…" row for a session that already exists
    bindings.delete('new-one')
    mgr.onTrackerUpdate()
    await vi.waitFor(() => expect(latest(repo).rows.map((r) => r.running)).toEqual([false, false]))
    expect(latest(repo).rows.some((r) => r.pending)).toBe(false)
  })

  it('drops the pending row when the launching pty dies (Cancel / early exit)', async () => {
    mgr.start()
    mgr.launchStarted('tab-1', repo)
    await vi.waitFor(() => expect(latest(repo).rows).toHaveLength(1))

    mgr.launchEnded('tab-1')
    await vi.waitFor(() => expect(latest(repo).rows).toEqual([]))
  })

  // The `claude -w <new>` shape end to end: the pty is spawned in the repo root, so the
  // launch cwd alone can only ever say `main`. Real Claude writes no jsonl until the
  // first user message, so the SessionStart hook's cwd is the ONLY thing that can label
  // the row in between — this is the wiring that carries it there.
  it('relabels a pending launch from the cwd its SessionStart hook reported', async () => {
    const { repoDir, wtDir } = gitRepoWithWorktree('bugfix')
    mgr.dispose()
    layout = { ...layout, workspaces: [{ path: repoDir }] }
    mgr = new WorkspaceManager({
      projectsRoot,
      remoteProjectsRoot: (host: string) => path.join(root, 'remote', host, 'projects'),
      loadLayout: () => layout,
      saveLayout: (l) => {
        layout = l
      },
      projectInfo: projectInfoFor,
      runningBindings: () => bindings,
      killTab: () => {},
      pushRows: (p) => pushed.push(p)
    })
    mgr.start()
    mgr.launchStarted('tab-1', repoDir)
    await vi.waitFor(() => expect(latest(repoDir).rows).toHaveLength(1))
    expect(latest(repoDir).rows[0].worktree).toBe('main')

    // claude created the worktree, cd'd into it, and the hook reported from there
    bindings.set('s1', 'tab-1')
    mgr.onSessionStart('tab-1', wtDir)
    mgr.onTrackerUpdate()
    await vi.waitFor(() =>
      expect(latest(repoDir).rows[0]).toMatchObject({
        id: 's1',
        worktree: 'bugfix',
        cwd: wtDir,
        running: true
      })
    )
    // …and no jsonl was ever written: the label came from the hook alone
    expect(fs.existsSync(path.join(projectsRoot, encodeCwd(wtDir)))).toBe(false)
  })

  it('counts a pending launch as a live session for workspace removal', async () => {
    const killed: string[] = []
    mgr.dispose()
    mgr = new WorkspaceManager({
      projectsRoot,
      remoteProjectsRoot: (host: string) => path.join(root, 'remote', host, 'projects'),
      loadLayout: () => layout,
      saveLayout: (l) => {
        layout = l
      },
      projectInfo: projectInfoFor,
      runningBindings: () => bindings,
      killTab: (t) => killed.push(t),
      pushRows: (p) => pushed.push(p)
    })
    mgr.start()
    mgr.launchStarted('tab-1', repo)
    await vi.waitFor(() => expect(latest(repo).rows).toHaveLength(1))

    expect(mgr.remove(repo)).toEqual({ running: 1, jobs: 0, removed: false })
    mgr.removeConfirmed(repo)
    expect(killed).toEqual(['tab-1'])
    expect(layout.workspaces.map((w) => w.path)).toEqual([plain])
  })

  // before scheduled jobs, a workspace with nothing running was unpinned on the
  // spot. Jobs never come back, so their count alone has to stop the removal and reach
  // the confirm text — this is the assertion that fails if `jobs` stops being counted.
  it('refuses to remove a quiet workspace that still owns scheduled jobs', async () => {
    mgr.dispose()
    mgr = new WorkspaceManager({
      projectsRoot,
      remoteProjectsRoot: (host: string) => path.join(root, 'remote', host, 'projects'),
      loadLayout: () => layout,
      saveLayout: (l) => {
        layout = l
      },
      projectInfo: projectInfoFor,
      runningBindings: () => bindings,
      killTab: () => {},
      pushRows: (p) => pushed.push(p),
      jobCountFor: (p) => (p === repo ? 2 : 0)
    })
    mgr.start()

    expect(mgr.remove(repo)).toEqual({ running: 0, jobs: 2, removed: false })
    expect(layout.workspaces.map((w) => w.path)).toContain(repo)
    // a workspace with neither runs nor jobs still goes in one step
    expect(mgr.remove(plain)).toEqual({ running: 0, jobs: 0, removed: true })
    expect(layout.workspaces.map((w) => w.path)).toEqual([repo])
  })
})

describe('WorkspaceManager: per-session Workbench state (T-AGG-09②, T-AUX-02/06)', () => {
  /** a fresh manager over the layout the previous one persisted = an app restart */
  function restart(): WorkspaceManager {
    mgr.dispose()
    mgr = new WorkspaceManager({
      projectsRoot,
      remoteProjectsRoot: (host: string) => path.join(root, 'remote', host, 'projects'),
      loadLayout: () => layout,
      saveLayout: (l) => {
        layout = l
      },
      projectInfo: projectInfoFor,
      runningBindings: () => bindings,
      killTab: () => {},
      pushRows: (p) => pushed.push(p)
    })
    return mgr
  }

  /** the bind that puts a session in the working set. The live binding goes in too: real
   *  Claude writes no jsonl until the first user message, so without it the rescan's §6 GC
   *  collects the entry `onSessionBound` just seeded (see the sweep's own comment). */
  function bind(sessionId: string): void {
    bindings.set(sessionId, 'tab-1')
    mgr.onSessionBound(sessionId)
  }

  it('falls back to the global default for a session it has never seen', () => {
    expect(mgr.workbenchState('unknown')).toEqual(SEEDED)
    expect(mgr.defaultOpen()).toBe(false)
  })

  it('persists the panel state and reads it back after a restart (A8)', async () => {
    const state: SessionWorkbenchState = {
      open: false,
      tabs: [{ kind: 'web', title: 'app', url: 'http://localhost:5173/' }]
    }
    bind('s1') // the bind is what puts a session in the working set
    mgr.setWorkbenchState('s1', state)
    // in-memory answer is immediate — the renderer never waits on the debounce
    expect(mgr.workbenchState('s1')).toEqual(state)

    await vi.waitFor(() => expect(layout.sessions.s1).toEqual(state), { timeout: 3000 })
    expect(restart().workbenchState('s1')).toEqual(state)
  })

  // D8: `open` and the tab set are one document now, so one submission carries both —
  // the v2 split (setAuxMode + setBrowser) is what let a mode toggle wipe the tabs
  it('replaces the whole entry, so closing the last tab really empties disk', () => {
    bind('s1')
    mgr.setWorkbenchState('s1', {
      open: true,
      tabs: [{ kind: 'file', title: 'a.ts', path: '/repo/a.ts' }]
    })
    mgr.setWorkbenchState('s1', { open: true, tabs: [] })
    mgr.dispose()
    expect(layout.sessions.s1).toEqual({ open: true, tabs: [] })
  })

  it('flushes a pending panel write on dispose (quit must not lose the last toggle)', () => {
    bind('s1')
    mgr.setWorkbenchState('s1', { open: false, tabs: [] })
    mgr.dispose()
    expect(layout.sessions.s1).toEqual({ open: false, tabs: [] })
  })

  // the lifecycle contract D13/FR-29 — a write UPDATES the working set and never grows it. The route
  // that made this matter: a guest's own `onTitle`/`onNavigate` still in flight when its
  // session `/exit`ed. `withWorkbenchState` mints the key for any id, so the late write
  // resurrected the entry, and ownership IS the sidebar row — the next rescan listed a
  // session the user had just removed, with the strip they had just lost.
  it('drops a write for a session that has left the working set (the row stays gone)', () => {
    bind('s1')
    mgr.setWorkbenchState('s1', {
      open: false,
      tabs: [{ kind: 'web', title: 'app', url: 'http://localhost:5173/' }]
    })
    mgr.dropOwnership('s1') // a graceful `/exit`; "Remove from list" is archiveSession
    expect(mgr.isMember('s1')).toBe(false)

    mgr.setWorkbenchState('s1', { open: true, tabs: [{ kind: 'web', title: 'late', url: 'u' }] })

    expect(mgr.isMember('s1')).toBe(false)
    mgr.dispose() // …and nothing was left pending to land after the flush either
    expect(layout.sessions.s1).toBeUndefined()
  })
})

describe('WorkspaceManager: working-set eviction (D1/D2)', () => {
  it('evicts a session the Archive guard refuses, and repeats as a no-op', async () => {
    writeJsonl(repo, 'live-1')
    layout.sessions['live-1'] = SEEDED
    bindings.set('live-1', 'tab-9')
    mgr.start()
    await vi.waitFor(() => expect(latest(repo).rows.map((r) => r.id)).toEqual(['live-1']))

    // D1 orders the eviction AFTER untrackSession, but the tracker entry can still be
    // settling — archiveSession's running guard would swallow the whole eviction
    expect(mgr.archiveSession('live-1')).toBe(false)
    mgr.dropOwnership('live-1')
    expect(layout.sessions['live-1']).toBeUndefined()
    expect(mgr.isMember('live-1')).toBe(false)

    const before = saves
    mgr.dropOwnership('live-1') // a re-read $tab.json replays the same end hook
    expect(saves).toBe(before)
  })

  // Real claude writes NO jsonl until the first user message, so a freshly bound
  // session is invisible to the jsonl sweep for that whole window (77s observed on
  //: bind 10:37:05, first jsonl write 10:38:22). The GC ran at the bind's
  // own rescan, dropped the just-seeded entry, and — since a rescan never adopts —
  // the session silently fell out of the working set for good, surfacing as "my
  // sessions from yesterday are gone" after the next restart.
  it('GC spares a bound running session whose jsonl has not been born yet', async () => {
    writeJsonl(repo, 'anchor-1') // any jsonl, so the GC sweep itself runs
    layout.sessions['fresh-1'] = SEEDED // hook bind seeded it
    bindings.set('fresh-1', 'tab-1') // and the tracker holds it as live
    mgr.start()
    await vi.waitFor(() => expect(pushed.length).toBeGreaterThan(0))
    expect(layout.sessions['fresh-1']).toEqual(SEEDED)

    // once the binding is gone AND there is still no jsonl, the entry really is
    // dead weight — the next sweep may collect it
    bindings.delete('fresh-1')
    mgr.onTrackerUpdate()
    await vi.waitFor(() => expect(layout.sessions['fresh-1']).toBeUndefined())
  })

  it('leaves the jsonl behind, so the evicted session is restorable history', async () => {
    writeJsonl(repo, 'gone-1')
    layout.sessions['gone-1'] = SEEDED
    mgr.start()
    await vi.waitFor(() => expect(latest(repo).rows.map((r) => r.id)).toEqual(['gone-1']))
    expect(latest(repo).workspace.hasHistory).toBe(false) // still a member: nothing to restore

    mgr.dropOwnership('gone-1')
    await vi.waitFor(() => expect(latest(repo).rows).toEqual([]))
    expect(latest(repo).workspace.hasHistory).toBe(true)
    expect(fs.existsSync(path.join(projectsRoot, encodeCwd(repo), 'gone-1.jsonl'))).toBe(true)
    expect(mgr.historyRows(repo).map((r) => r.id)).toEqual(['gone-1'])
  })
})

describe('WorkspaceManager: restore from history (D5)', () => {
  it('offers exactly the non-member, non-running sessions, newest first', async () => {
    writeJsonl(repo, 'owned-1')
    writeJsonl(repo, 'hist-old')
    writeJsonl(repo, 'hist-new')
    writeJsonl(repo, 'bound-1')
    setMtime(repo, 'hist-old', 1000)
    setMtime(repo, 'hist-new', 2000)
    layout.sessions['owned-1'] = SEEDED
    bindings.set('bound-1', 'tab-1') // running but unowned — a member by the running fallback
    mgr.start()
    await vi.waitFor(() => expect(pushed.length).toBeGreaterThan(0))

    expect(mgr.historyRows(repo).map((r) => r.id)).toEqual(['hist-new', 'hist-old'])
    expect(mgr.historyRows(path.join(root, 'never-pinned'))).toEqual([])
    // D9: the same answer travels on the pushed rows, so the menu can grey its
    // Restore item the instant it opens
    expect(latest(repo).workspace.hasHistory).toBe(true)
    expect(latest(plain).workspace.hasHistory).toBe(false)
  })

  it('finds an unowned row for the resume planner (the sidebar never showed it)', async () => {
    writeJsonl(repo, 'ext-9')
    mgr.start()
    await vi.waitFor(() => expect(pushed.length).toBeGreaterThan(0))

    expect(latest(repo).rows).toEqual([])
    expect(mgr.findRow('ext-9')).toMatchObject({ id: 'ext-9', cwd: repo })
    expect(mgr.findRow('nobody')).toBeUndefined()
  })
})

describe('WorkspaceManager: /clear id change (T-LIFE-07)', () => {
  // FR-29: /clear MOVES the tab set to the new id — a carry that took `open` alone would
  // leave the user's pages on the dead id, so the entry under test carries a real tab
  const entry: SessionWorkbenchState = {
    open: true,
    tabs: [{ kind: 'web', title: 'app', url: 'http://localhost:5173/' }]
  }

  it('persists the carried panel state, and writes nothing on a /resume switch', () => {
    layout.sessions = { old: entry } // loadLayout handed the manager this very object

    // the rebind only COPIES; evicting the old id is D2's separate dropOwnership call
    // (index.ts makes both, in this order — see the working-set eviction suite)
    mgr.onSessionRebind('old', 'fresh', 'clear')
    expect(layout.sessions).toEqual({ old: entry, fresh: entry })

    const saved = layout
    mgr.onSessionRebind('fresh', 'target', 'resume')
    expect(layout).toBe(saved) // no save at all — the table is untouched
  })
})

describe('WorkspaceManager: worktrees() stale-dir filter (T-NEW-07 successor)', () => {
  it('drops an entry git still lists after its checkout directory was deleted', async () => {
    const { repoDir, wtDir } = gitRepoWithWorktree('alive')
    const git = (...args: string[]): void => {
      execFileSync('git', ['-C', repoDir, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
        stdio: 'ignore'
      })
    }
    const goneDir = path.join(repoDir, '.claude', 'worktrees', 'gone')
    git('worktree', 'add', '-q', '-b', 'worktree-gone', goneDir)
    fs.rmSync(goneDir, { recursive: true, force: true })

    const list = await mgr.worktrees(repoDir)
    // main checkout excluded, deleted checkout filtered, survivor intact
    expect(list.map((w) => w.name)).toEqual(['alive'])
    expect(list[0].dir).toBe(wtDir)
  })
})

describe('WorkspaceManager: a rescan re-reads only the transcript heads that changed', () => {
  // Every jsonl append in a pinned bucket fires the bucket watcher, and a rescan
  // used to re-open EVERY transcript of every pinned workspace — hundreds of files,
  // up to 256KB each, all synchronous on the main thread. With a few live sessions
  // typing, that was a ~1s stall every few seconds, felt as hover/click lag across
  // the whole window (2026-09-04 profile: 1045/598/565ms blocks in 20s, all here).
  // The oracle is which .jsonl files get opened, not how many rescans ran: the
  // append itself may fire a watcher rescan alongside the one the test triggers.
  it('skips unchanged files, re-reads a grown one, never re-reads a settled head', async () => {
    const dir = path.join(projectsRoot, encodeCwd(repo))
    writeJsonl(repo, 'quiet-1') // summary + cwd only: unsettled, but it never changes
    fs.mkdirSync(dir, { recursive: true })
    // no summary/title yet — the row is titled by its age until one lands
    fs.writeFileSync(
      path.join(dir, 'grows-1.jsonl'),
      JSON.stringify({ type: 'user', cwd: repo, timestamp: '2026-08-08T11:00:00.000Z' }) + '\n'
    )
    // every head field present: the scan stops early, so no append can change it
    fs.writeFileSync(
      path.join(dir, 'settled-1.jsonl'),
      [
        { type: 'summary', summary: 'settled' },
        { type: 'ai-title', aiTitle: 'Settled name' },
        {
          type: 'user',
          cwd: repo,
          timestamp: '2026-08-08T11:00:00.000Z',
          message: { content: 'hello' }
        }
      ]
        .map((o) => JSON.stringify(o))
        .join('\n') + '\n'
    )
    for (const id of ['quiet-1', 'grows-1', 'settled-1']) layout.sessions[id] = SEEDED
    mgr.start()
    await vi.waitFor(() =>
      expect(
        latest(repo)
          .rows.map((r) => r.id)
          .sort()
      ).toHaveLength(3)
    )
    const titleOf = (id: string): string | undefined =>
      latest(repo).rows.find((r) => r.id === id)?.title
    expect(titleOf('settled-1')).toBe('Settled name')
    expect(titleOf('grows-1')).not.toBe('later summary')

    const opened = vi.spyOn(fs, 'openSync')
    const jsonlOpened = (): string[] => [
      ...new Set(
        opened.mock.calls
          .map((c) => String(c[0]))
          .filter((p) => p.endsWith('.jsonl'))
          .map((p) => path.basename(p))
      )
    ]
    // a rescan with nothing changed on disk opens no transcript at all
    bindings.set('quiet-1', 'tab-q')
    mgr.onTrackerUpdate()
    await vi.waitFor(() =>
      expect(latest(repo).rows.find((r) => r.id === 'quiet-1')?.running).toBe(true)
    )
    expect(jsonlOpened()).toEqual([])

    // the unsettled head grew: read again, and the new field shows
    fs.appendFileSync(
      path.join(dir, 'grows-1.jsonl'),
      JSON.stringify({ type: 'summary', summary: 'later summary' }) + '\n'
    )
    bindings.set('grows-1', 'tab-g')
    mgr.onTrackerUpdate()
    await vi.waitFor(() => expect(titleOf('grows-1')).toBe('later summary'))
    expect(jsonlOpened()).toEqual(['grows-1.jsonl'])

    // the settled head grew too: nothing past its early stop can matter — not re-read
    fs.appendFileSync(
      path.join(dir, 'settled-1.jsonl'),
      JSON.stringify({ type: 'assistant', message: { content: 'more' } }) + '\n'
    )
    bindings.set('settled-1', 'tab-s')
    mgr.onTrackerUpdate()
    await vi.waitFor(() =>
      expect(latest(repo).rows.find((r) => r.id === 'settled-1')?.running).toBe(true)
    )
    expect(jsonlOpened()).toEqual(['grows-1.jsonl'])
    expect(titleOf('settled-1')).toBe('Settled name')
  })

  // A transcript that could not be opened (EMFILE mid-rescan, a permission blip)
  // yields an empty head. Remembering THAT under the file's unchanged size/mtime
  // would leave a finished session titled by its age for good — the file never
  // grows again, so nothing would ever trigger a re-read.
  it('does not remember a head it could not open, so the next rescan reads it', async () => {
    const dir = path.join(projectsRoot, encodeCwd(repo))
    writeJsonl(repo, 'locked-1') // summary "a session"
    const file = path.join(dir, 'locked-1.jsonl')
    fs.chmodSync(file, 0o000)
    layout.sessions['locked-1'] = SEEDED
    mgr.start()
    await vi.waitFor(() => expect(latest(repo).rows.map((r) => r.id)).toEqual(['locked-1']))
    expect(latest(repo).rows[0].title).not.toBe('a session')

    // readable again, size and mtime untouched — the only signal is the failed open
    fs.chmodSync(file, 0o644)
    bindings.set('locked-1', 'tab-l')
    mgr.onTrackerUpdate()
    await vi.waitFor(() => expect(latest(repo).rows[0].title).toBe('a session'))
  })
})

// U-OB-01: the welcome's "folders you already work in" list. Every rule in it is
// filesystem judgement the pure modules never see — which recorded cwds are still real,
// which are Koloft's own worktree checkouts, and which several slugs are one repo — so it
// is driven here against a real Claude storage tree.
describe('WorkspaceManager: discover', () => {
  /** a transcript that records no cwd at all — a headless/empty session file */
  function writeCwdlessJsonl(cwd: string, id: string): void {
    const dir = path.join(projectsRoot, encodeCwd(cwd))
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(
      path.join(dir, id + '.jsonl'),
      JSON.stringify({ type: 'summary', summary: 'a session' }) + '\n'
    )
  }

  it('collapses a repo’s slugs and drops the ones that are not offerable', () => {
    const a = path.join(root, 'a')
    const sub = path.join(a, 'sub')
    fs.mkdirSync(path.join(a, '.git'), { recursive: true })
    fs.mkdirSync(sub)
    writeJsonl(a, 'a-1')
    writeJsonl(a, 'a-2')
    setMtime(a, 'a-1', 1000)
    setMtime(a, 'a-2', 1000)
    writeJsonl(sub, 'sub-1')
    setMtime(sub, 'sub-1', 9000) // the newest transcript anywhere in the repo

    writeJsonl(path.join(root, 'gone'), 'gone-1') // the recorded cwd's directory is deleted

    // a `claude -w` session: filed under the repo's own slug, cwd = the (since deleted)
    // worktree — the repo still counts it, and is still offered
    const c = path.join(root, 'c')
    fs.mkdirSync(path.join(c, '.git'), { recursive: true })
    writeJsonl(c, 'c-1')
    setMtime(c, 'c-1', 500)
    const cSlug = path.join(projectsRoot, encodeCwd(c))
    const wtGone = path.join(c, '.claude', 'worktrees', 'x')
    fs.writeFileSync(
      path.join(cSlug, 'c-0-wt.jsonl'),
      JSON.stringify({ type: 'user', cwd: wtGone, sessionId: 'c-0-wt' }) + '\n'
    )
    fs.utimesSync(path.join(cSlug, 'c-0-wt.jsonl'), 500, 500)
    // a worktree that still exists, under its own slug: it belongs to the repo above it
    const wtLive = path.join(c, '.claude', 'worktrees', 'y')
    fs.mkdirSync(wtLive, { recursive: true })
    writeJsonl(wtLive, 'wt-1')
    setMtime(wtLive, 'wt-1', 700)

    const d = path.join(root, 'd')
    fs.mkdirSync(d)
    writeJsonl(d, 'd-1')
    mgr.add(d) // already pinned

    const e = path.join(root, 'e')
    fs.mkdirSync(e)
    writeCwdlessJsonl(e, 'e-1') // no cwd to resolve

    expect(mgr.discover()).toEqual([
      { path: a, sessions: 3, mtime: 9000_000 },
      { path: c, sessions: 3, mtime: 700_000 }
    ])
  })

  it('offers at most 8 folders, newest first', () => {
    for (let i = 0; i < 9; i++) {
      const dir = path.join(root, 'p' + i)
      fs.mkdirSync(dir)
      writeJsonl(dir, 'p' + i + '-1')
      setMtime(dir, 'p' + i + '-1', 1000 + i)
    }
    const found = mgr.discover()
    expect(found).toHaveLength(8)
    expect(found.map((f) => path.basename(f.path))).toEqual([
      'p8',
      'p7',
      'p6',
      'p5',
      'p4',
      'p3',
      'p2',
      'p1'
    ])
  })
})

// ---- remote workspaces -----------------------------------------------------
// A remote workspace is the same layout entry with an `ssh://` path. What the manager
// must NOT do with it is the whole point: no stat, no git probe, and every read
// redirected to the machine's mirror under userData. The private helpers cannot be
// stubbed, so this drives the real thing against a mirror tree on disk.

const RKEY = 'ssh://devbox/home/koh/api'
const RPATH = '/home/koh/api'

function writeMirrorJsonl(id: string, cwd = RPATH): void {
  const dir = path.join(root, 'remote', 'devbox', 'projects', encodeCwd(cwd))
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, id + '.jsonl'),
    JSON.stringify({ type: 'summary', summary: 'a remote session' }) +
      '\n' +
      JSON.stringify({ type: 'user', cwd, timestamp: '2026-09-07T11:00:00.000Z', sessionId: id }) +
      '\n'
  )
}

function remoteMgr(extra: Record<string, unknown> = {}): WorkspaceManager {
  mgr.dispose()
  pushed = []
  return new WorkspaceManager({
    projectsRoot,
    remoteProjectsRoot: (host: string) => path.join(root, 'remote', host, 'projects'),
    loadLayout: () => layout,
    saveLayout: (l) => {
      layout = l
    },
    projectInfo: projectInfoFor,
    runningBindings: () => bindings,
    killTab: () => {},
    pushRows: (p) => pushed.push(p),
    ...extra
  })
}

describe('remote workspace: pinning', () => {
  // U-WS-1
  it('pins an ssh key verbatim, without touching a disk', () => {
    expect(mgr.add(RKEY)).toEqual({ code: 'added', path: RKEY })
    expect(layout.workspaces.map((w) => w.path)).toContain(RKEY)
    expect(mgr.add(RKEY)).toEqual({ code: 'exists', path: RKEY })
    expect(mgr.add('ssh://devbox')).toEqual({ code: 'not-found' })
  })

  it('never calls a remote pin missing, and offers no worktrees until the machine speaks', async () => {
    mgr.add(RKEY)
    expect(mgr.pinnedPaths()).toContainEqual({ path: RKEY, missing: false })
    expect(await mgr.worktrees(RKEY)).toEqual([])
  })

  // the machine's list, minus the main checkout, is the whole "Run in" offer —
  // this Mac can neither run git there nor stat those directories
  it('offers the worktrees the machine reported, named by their folder', async () => {
    layout.workspaces = [{ path: RKEY }]
    mgr = remoteMgr({
      remoteGit: () => ({
        isGit: true,
        worktrees: [
          { dir: RPATH, branch: 'main' },
          { dir: `${RPATH}/.claude/worktrees/feature`, branch: 'worktree-feature' }
        ]
      })
    })
    expect(await mgr.worktrees(RKEY)).toEqual([
      {
        name: 'feature',
        dir: `${RPATH}/.claude/worktrees/feature`,
        branch: 'worktree-feature'
      }
    ])
  })

  // claude slugs the PHYSICAL cwd (contract §2), so a folder pinned through a
  // symlink has nothing under the typed path's slug
  it('reads the mirror under the path the machine resolved, not the one that was pinned', async () => {
    writeMirrorJsonl('sym', '/mnt/disk2/api')
    layout.workspaces = [{ path: RKEY }]
    layout.sessions = { sym: SEEDED }
    mgr = remoteMgr({
      remoteGit: () => ({ isGit: false, worktrees: [], real: '/mnt/disk2/api' })
    })
    mgr.start()
    await vi.waitFor(() => expect(latest(RKEY).rows.length).toBe(1))
    expect(latest(RKEY).rows[0].id).toBe('sym')
  })

  // U-WS-2
  it('runs no local repo probe at all for a remote workspace', async () => {
    const bin = path.join(root, 'fakebin')
    const log = path.join(root, 'argv.log')
    fs.mkdirSync(bin)
    fs.writeFileSync(
      path.join(bin, 'git'),
      '#!/bin/sh\nprintf "%s\\n" "$*" >> ' + JSON.stringify(log) + '\nexit 1\n',
      { mode: 0o755 }
    )
    const realPath = process.env.PATH ?? ''
    process.env.PATH = bin + ':' + realPath
    try {
      layout.workspaces = [{ path: RKEY }]
      mgr = remoteMgr()
      mgr.start()
      await vi.waitFor(() => expect(pushed.length).toBeGreaterThan(0))
      const ws = latest(RKEY).workspace
      expect(ws.missing).toBe(false)
      expect(ws.isGit).toBe(false)
      expect(ws.remote).toEqual({ host: 'devbox', path: RPATH, connected: false })
      const argv = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : ''
      expect(argv).not.toContain('ssh://')
    } finally {
      process.env.PATH = realPath
    }
  })
})

describe('remote workspace: reading the mirror', () => {
  beforeEach(() => {
    layout.workspaces = [{ path: repo }, { path: RKEY }]
  })

  // U-READ-1, U-READ-2
  it('turns a mirrored transcript into a row whose resume is not blocked', async () => {
    writeMirrorJsonl('abc')
    layout.sessions = { abc: SEEDED }
    mgr = remoteMgr()
    mgr.start()
    await vi.waitFor(() => expect(latest(RKEY).rows.length).toBe(1))
    const row = latest(RKEY).rows[0]
    expect(row.id).toBe('abc')
    // the cwd names a directory on the machine; this Mac cannot stat it, and calling
    // it invalid would grey the row's resume out for good
    expect(row.invalidCwd).toBe(false)
    expect(row.cwd).toBe(RPATH)
  })

  // U-READ-3, U-READ-4
  it('keeps a mirrored session through GC while still collecting a local orphan', async () => {
    writeMirrorJsonl('abc')
    writeJsonl(repo, 'local1')
    layout.sessions = { abc: SEEDED, local1: SEEDED, ghost: SEEDED }
    mgr = remoteMgr()
    mgr.start()
    await vi.waitFor(() => expect(latest(RKEY).rows.length).toBe(1))
    await vi.waitFor(() => expect(Object.keys(layout.sessions).sort()).toEqual(['abc', 'local1']))
    expect(latest(repo).rows.map((r) => r.id)).toEqual(['local1'])
  })

  it('counts a session the machine reports as alive as running', async () => {
    writeMirrorJsonl('abc')
    layout.sessions = { abc: SEEDED }
    mgr = remoteMgr({
      remoteRunning: () => new Set(['abc']),
      remoteConnected: () => true
    })
    mgr.start()
    await vi.waitFor(() => expect(latest(RKEY).rows.length).toBe(1))
    expect(latest(RKEY).rows[0].running).toBe(true)
    expect(latest(RKEY).workspace.remote?.connected).toBe(true)
    expect(mgr.historyRows(RKEY)).toEqual([])
  })

  // a worktree session over there writes into a slug of its own. Only the
  // machine's own worktree list can tie that folder back to this workspace.
  it('takes isGit and the extra buckets from what the machine said', async () => {
    const wtPath = `${RPATH}/.claude/worktrees/feature`
    writeMirrorJsonl('abc')
    writeMirrorJsonl('wt1', wtPath)
    layout.workspaces = [{ path: RKEY }]
    layout.sessions = { abc: SEEDED, wt1: SEEDED }
    mgr = remoteMgr({
      remoteGit: () => ({
        isGit: true,
        worktrees: [{ dir: RPATH }, { dir: wtPath, branch: 'worktree-feature' }]
      })
    })
    mgr.start()
    await vi.waitFor(() => expect(latest(RKEY).rows.length).toBe(2))
    expect(latest(RKEY).workspace.isGit).toBe(true)
    expect(
      latest(RKEY)
        .rows.map((r) => r.worktree)
        .sort()
    ).toEqual(['feature', 'main'])
  })

  it('reports which workspace a session belongs to, and what to mirror', async () => {
    writeMirrorJsonl('abc')
    writeJsonl(repo, 'local1')
    layout.sessions = { abc: SEEDED, local1: SEEDED }
    mgr = remoteMgr()
    mgr.start()
    await vi.waitFor(() => expect(latest(RKEY).rows.length).toBe(1))
    expect(mgr.workspaceOf('abc')).toBe(RKEY)
    expect(mgr.workspaceOf('local1')).toBe(repo)
    expect(mgr.remoteTargets()).toEqual([{ host: 'devbox', paths: [RPATH] }])
  })

  // one machine can hold two pinned folders. The heartbeat mirrors a HOST once per
  // round, so two entries for one host would leave the second folder's transcripts
  // never pulled — the rows for it stay empty forever.
  it('gives a machine one target carrying every folder pinned on it', async () => {
    layout.workspaces = [{ path: repo }, { path: RKEY }, { path: 'ssh://devbox/srv/www' }]
    mgr = remoteMgr()
    expect(mgr.remoteTargets()).toEqual([
      {
        host: 'devbox',
        paths: [RPATH, '/srv/www']
      }
    ])
  })

  // a session alive in tmux with no tab in this Koloft (started before a restart) is
  // just as running: unpinning must ask about it, and then really end it over there
  it('counts and kills a running remote session that has no tab here', async () => {
    writeMirrorJsonl('abc')
    layout.sessions = { abc: SEEDED }
    const killedRemote: string[] = []
    mgr = remoteMgr({
      remoteRunning: () => new Set(['abc']),
      remoteConnected: () => true,
      killRemoteSession: (host: string, id: string) => killedRemote.push(`${host}/${id}`)
    })
    mgr.start()
    await vi.waitFor(() => expect(latest(RKEY).rows.length).toBe(1))

    expect(mgr.remove(RKEY)).toEqual({ running: 1, jobs: 0, removed: false })
    mgr.removeConfirmed(RKEY)
    expect(killedRemote).toEqual(['devbox/abc'])
    expect(layout.workspaces.map((w) => w.path)).not.toContain(RKEY)
  })

  // killTab drops the tab's binding on the spot, so a session with a tab must not
  // ALSO read as an orphan a moment later and be killed twice
  it('kills a session that has a tab here exactly once', async () => {
    writeMirrorJsonl('abc')
    layout.sessions = { abc: SEEDED }
    const bindings = new Map([['abc', 'tab-1']])
    const killedTabs: string[] = []
    const killedRemote: string[] = []
    mgr = remoteMgr({
      runningBindings: () => bindings,
      remoteRunning: () => new Set(['abc']),
      remoteConnected: () => true,
      killTab: (tabId: string) => {
        killedTabs.push(tabId)
        bindings.delete('abc')
      },
      killRemoteSession: (host: string, id: string) => killedRemote.push(`${host}/${id}`)
    })
    mgr.start()
    await vi.waitFor(() => expect(latest(RKEY).rows.length).toBe(1))

    mgr.removeConfirmed(RKEY)
    expect(killedTabs).toEqual(['tab-1'])
    expect(killedRemote).toEqual([])
  })

  it('keeps a local slug of the same name out of the remote workspace', async () => {
    // both roots can hold the same slug name — the machine's /home/koh/api and a local
    // folder at that path — so a slug-keyed read would mix the two together
    writeMirrorJsonl('remote1')
    const dupDir = path.join(projectsRoot, encodeCwd(RPATH))
    fs.mkdirSync(dupDir, { recursive: true })
    fs.writeFileSync(
      path.join(dupDir, 'localdup.jsonl'),
      JSON.stringify({ type: 'user', cwd: RPATH, timestamp: '2026-09-07T11:00:00.000Z' }) + '\n'
    )
    layout.sessions = { remote1: SEEDED, localdup: SEEDED }
    mgr = remoteMgr()
    mgr.start()
    await vi.waitFor(() => expect(latest(RKEY).rows.length).toBeGreaterThan(0))
    expect(latest(RKEY).rows.map((r) => r.id)).toEqual(['remote1'])
  })
})

describe('mixed session backends', () => {
  it('keeps source identities, membership, common creation order and pending removal counts', async () => {
    mgr.dispose()
    const native = '00000000-0000-4000-8000-000000000001'
    const codexKey = 'codex:local:' + native
    const codexDir = path.join(repo, '.koloft', 'worktrees', 'codex-feature')
    fs.mkdirSync(codexDir, { recursive: true })
    writeJsonl(repo, native, '2026-08-08T11:00:00.000Z')
    layout.sessions[native] = SEEDED
    bindings.set(codexKey, 'codex-tab')
    const members = new Set([codexKey, 'pending-tab'])
    const extra = [
      {
        id: codexKey,
        backendId: 'codex' as const,
        title: 'newer',
        cwd: codexDir,
        worktree: 'codex-feature',
        running: true,
        invalidCwd: false,
        mtime: 1,
        createdAt: Date.parse('2026-08-09T11:00:00.000Z')
      },
      {
        id: 'codex:local:history',
        backendId: 'codex' as const,
        title: 'external history',
        cwd: repo,
        worktree: 'main',
        running: false,
        invalidCwd: false,
        mtime: 2,
        createdAt: 2
      },
      {
        id: 'pending-tab',
        backendId: 'codex' as const,
        title: 'Starting…',
        cwd: repo,
        worktree: 'main',
        running: true,
        pending: true,
        invalidCwd: false,
        mtime: 3
      }
    ]
    mgr = new WorkspaceManager({
      projectsRoot,
      remoteProjectsRoot: () => projectsRoot,
      loadLayout: () => layout,
      saveLayout: (l) => {
        layout = l
      },
      projectInfo: projectInfoFor,
      runningBindings: () => bindings,
      killTab: () => {},
      pushRows: (p) => pushed.push(p),
      additionalRows: (ws) => (ws === repo ? extra : []),
      additionalMembers: () => members
    })
    mgr.start()
    await mgr.firstScan
    expect(latest(repo).rows.map((r) => r.id)).toEqual(['pending-tab', codexKey, native])
    expect(mgr.historyRows(repo).map((r) => r.id)).toEqual(['codex:local:history'])
    expect(mgr.remove(repo)).toMatchObject({ running: 2, removed: false })
    expect(layout.sessions[native]).toEqual(SEEDED)
    expect(layout.sessions[codexKey]).toBeUndefined()
    expect(latest(repo).rows.find((r) => r.id === native)?.revealDir).toBe(repo)
    expect(latest(repo).rows.find((r) => r.id === codexKey)?.revealDir).toBe(codexDir)
    bindings.delete(codexKey)
    extra[0].running = false
    mgr.onTrackerUpdate()
    await vi.waitFor(() =>
      expect(latest(repo).rows.find((r) => r.id === codexKey)).toMatchObject({
        running: false,
        worktree: 'codex-feature',
        revealDir: codexDir
      })
    )
    fs.rmSync(codexDir, { recursive: true })
    mgr.restampLive()
    expect(latest(repo).rows.find((r) => r.id === codexKey)?.revealDir).toBeUndefined()
  })
})

// claude can move a RUNNING session into another checkout mid-conversation. A
// row's worktree label and the folder its menu opens both come off the bucket the
// transcript sits in, which is right until that happens; from then on only the live
// tracker knows. Both are stamped on in one place, on the way out — the label only for a
// session claude really moved, since before that the tracker knows no more than the
// directory the tab was launched in.
describe('WorkspaceManager: a running session that moved', () => {
  /** what the live tracker would say about each running session */
  let live: Map<string, LiveSession>

  /** a transcript that REMEMBERS a worktree binding — the shape a session leaves behind
   *  once it has been in one, and the reason the bucket answer can be stale (D11) */
  function writeBoundJsonl(cwd: string, id: string, wtPath: string): void {
    const dir = path.join(projectsRoot, encodeCwd(cwd))
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(
      path.join(dir, id + '.jsonl'),
      JSON.stringify({ type: 'user', cwd, timestamp: '2026-09-10T11:00:00.000Z', sessionId: id }) +
        '\n' +
        JSON.stringify({
          type: 'worktree-state',
          sessionId: id,
          worktreeSession: {
            originalCwd: cwd,
            worktreePath: wtPath,
            worktreeName: path.basename(wtPath),
            worktreeBranch: 'worktree-' + path.basename(wtPath),
            originalHeadCommit: 'abc123'
          }
        }) +
        '\n'
    )
  }

  /** the same dep set every other case here builds, plus the live tracker */
  function liveMgr(extra: Record<string, unknown> = {}): WorkspaceManager {
    return remoteMgr({ liveSessions: () => live, ...extra })
  }

  beforeEach(() => {
    live = new Map()
  })

  it('takes the live worktree of a session claude moved, and leaves the others alone', async () => {
    const wt = path.join(repo, '.claude', 'worktrees', 'eng')
    fs.mkdirSync(wt, { recursive: true })
    // all three transcripts sit in the workspace's own bucket and all remember 'eng'
    writeBoundJsonl(repo, 'left-1', wt)
    writeBoundJsonl(repo, 'in-1', wt)
    writeBoundJsonl(repo, 'resumed-1', wt)
    layout = {
      ...layout,
      workspaces: [{ path: repo }],
      sessions: { 'left-1': SEEDED, 'in-1': SEEDED, 'resumed-1': SEEDED }
    }
    bindings.set('left-1', 'tab-a')
    bindings.set('in-1', 'tab-b')
    bindings.set('resumed-1', 'tab-c')
    // claude moved two: one out of the worktree (no worktree resolves for the checkout
    // itself), the other into it
    live.set('left-1', { treeRoot: repo, relocated: true })
    live.set('in-1', { treeRoot: wt, worktree: 'eng', relocated: true })
    // …and the third was RESUMED and has not moved: the tracker is still on the launch
    // directory, which claude leaves as soon as it re-enters the worktree, so its answer
    // is not the row's to take
    live.set('resumed-1', { treeRoot: repo })
    mgr = liveMgr()
    mgr.start()
    await vi.waitFor(() => expect(latest(repo).rows.length).toBe(3))
    const rows = latest(repo).rows
    expect(rows.find((r) => r.id === 'left-1')).toMatchObject({ worktree: 'main', revealDir: repo })
    expect(rows.find((r) => r.id === 'in-1')).toMatchObject({ worktree: 'eng', revealDir: wt })
    expect(rows.find((r) => r.id === 'resumed-1')).toMatchObject({ worktree: 'eng' })
  })

  it('hands back no folder for a RUNNING session whose folder was removed under it', async () => {
    // the worktree was pulled out from under a live session: the tracker still points at
    // that checkout until the session's next logged directory re-homes it, so the folder
    // is simply not there — and the menu item that would open it has to grey out
    const gone = path.join(repo, '.claude', 'worktrees', 'pulled')
    writeJsonl(repo, 'live-2')
    layout = { ...layout, workspaces: [{ path: repo }], sessions: { 'live-2': SEEDED } }
    bindings.set('live-2', 'tab-z')
    live.set('live-2', { treeRoot: gone, worktree: 'pulled', relocated: true })
    mgr = liveMgr()
    mgr.start()
    await vi.waitFor(() => expect(latest(repo).rows.length).toBe(1))
    // the label is still the live answer; only the menu has nowhere to go
    expect(latest(repo).rows[0]).toMatchObject({ worktree: 'pulled' })
    expect(latest(repo).rows[0].revealDir).toBeUndefined()
  })

  it('a cold row keeps what its bucket says, and points at that folder', async () => {
    writeJsonl(repo, 'cold-1')
    layout = { ...layout, workspaces: [{ path: repo }], sessions: { 'cold-1': SEEDED } }
    mgr = liveMgr()
    mgr.start()
    await vi.waitFor(() => expect(latest(repo).rows.length).toBe(1))
    expect(latest(repo).rows[0]).toMatchObject({
      worktree: 'main',
      revealDir: repo,
      running: false
    })
  })

  it('hands back no folder when the one it would open is gone (the menu item greys)', async () => {
    const { repoDir, wtDir } = gitRepoWithWorktree('vanished')
    writeJsonl(wtDir, 'wt-1')
    execFileSync('git', ['-C', repoDir, 'worktree', 'remove', wtDir], { stdio: 'ignore' })
    layout = { ...layout, workspaces: [{ path: repoDir }], sessions: { 'wt-1': SEEDED } }
    mgr = liveMgr()
    mgr.start()
    await vi.waitFor(() => expect(latest(repoDir).rows.length).toBe(1))
    expect(latest(repoDir).rows[0]).toMatchObject({ worktree: 'vanished', invalidCwd: true })
    expect(latest(repoDir).rows[0].revealDir).toBeUndefined()
  })

  it('leaves a remote row alone: its worktree is the machine’s to know', async () => {
    const wtPath = `${RPATH}/.claude/worktrees/feature`
    writeMirrorJsonl('wt1', wtPath)
    layout = { ...layout, workspaces: [{ path: RKEY }], sessions: { wt1: SEEDED } }
    // the tracker never resolves a worktree for a remote session (it would walk THIS
    // disk), so only its directory is known — stamping a label on would undo the row
    live.set('wt1', { treeRoot: wtPath, remote: true })
    mgr = liveMgr({
      remoteRunning: () => new Set(['wt1']),
      remoteConnected: () => true,
      remoteGit: () => ({
        isGit: true,
        worktrees: [{ dir: RPATH }, { dir: wtPath, branch: 'worktree-feature' }]
      })
    })
    mgr.start()
    await vi.waitFor(() => expect(latest(RKEY).rows.length).toBe(1))
    // the label stays the machine's answer; the folder still follows the live session
    expect(latest(RKEY).rows[0]).toMatchObject({ worktree: 'feature', revealDir: wtPath })
  })
})
