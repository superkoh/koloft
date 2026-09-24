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

let root: string
let projectsRoot: string
let repo: string
let plain: string
let layout: LayoutV4
let bindings: Map<string, string>
let pushed: WorkspaceRows[][]
let saves: number
let mgr: WorkspaceManager

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
    layout.sessions = { ghost: SEEDED }
    mgr.dispose()
    mgr = new WorkspaceManager({
      projectsRoot,
      remoteProjectsRoot: (host: string) => path.join(root, 'remote', host, 'projects'),
      loadLayout: () => layout,
      saveLayout: (l) => {
        layout = l
        behind = 7
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
    expect(layout.sessions['ext-1']).toBeUndefined()

    mgr.onSessionBound('ext-1')
    await vi.waitFor(() => expect(latest(repo).rows.map((r) => r.id)).toEqual(['ext-1']))
    expect(layout.sessions['ext-1']).toEqual(SEEDED)
  })
})

describe('WorkspaceManager: cold-row title parity with the live tracker', () => {
  it('prefers the `<id>.title` sidecar over the jsonl-head title', async () => {
    writeJsonl(repo, 's1')
    fs.writeFileSync(path.join(projectsRoot, encodeCwd(repo), 's1.title'), 'Fresh AI name\n')
    layout.sessions['s1'] = SEEDED
    mgr.start()
    await vi.waitFor(() => expect(latest(repo).rows.map((r) => r.title)).toEqual(['Fresh AI name']))
  })
})

describe('WorkspaceManager: orphan worktree bucket (D2)', () => {
  // CC§4
  it('shows an owned session whose worktree was removed as a greyed row under its old name', async () => {
    const { repoDir, wtDir } = gitRepoWithWorktree('bugfix')
    writeJsonl(wtDir, 'wt-1')
    execFileSync('git', ['-C', repoDir, 'worktree', 'remove', wtDir], { stdio: 'ignore' })
    mgr.dispose()
    layout = {
      ...layout,
      workspaces: [{ path: repoDir }],
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
    layout.sessions['old-one'] = SEEDED
    mgr.start()
    await vi.waitFor(() => expect(latest(repo).rows).toHaveLength(1))

    mgr.launchStarted('tab-1', repo)
    await vi.waitFor(() => {
      const rows = latest(repo).rows
      expect(rows).toHaveLength(2)
      expect(rows[0]).toMatchObject({
        id: 'tab-1',
        title: PENDING_SESSION_TITLE,
        worktree: 'main',
        pending: true,
        running: false
      })
    })
    expect(latest(plain).rows).toEqual([])

    writeJsonl(repo, 'new-one', '2026-08-08T12:00:00.000Z')
    bindings.set('new-one', 'tab-1')
    mgr.onSessionBound('new-one')
    mgr.onTrackerUpdate()
    await vi.waitFor(() => {
      const rows = latest(repo).rows
      expect(rows.map((r) => r.id)).toEqual(['new-one', 'old-one'])
      expect(rows.some((r) => r.pending)).toBe(false)
    })

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

  // CC§2
  it('relabels a pending launch from the cwd its SessionStart hook reported, before any jsonl exists', async () => {
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
    expect(mgr.remove(plain)).toEqual({ running: 0, jobs: 0, removed: true })
    expect(layout.workspaces.map((w) => w.path)).toEqual([repo])
  })
})

describe('WorkspaceManager: per-session Workbench state (T-AGG-09②, T-AUX-02/06)', () => {
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

  // CC§2
  function bindAsRunning(sessionId: string): void {
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
    bindAsRunning('s1')
    mgr.setWorkbenchState('s1', state)
    expect(mgr.workbenchState('s1')).toEqual(state)

    await vi.waitFor(() => expect(layout.sessions.s1).toEqual(state), { timeout: 3000 })
    expect(restart().workbenchState('s1')).toEqual(state)
  })

  it('replaces the whole entry, so closing the last tab really empties disk', () => {
    bindAsRunning('s1')
    mgr.setWorkbenchState('s1', {
      open: true,
      tabs: [{ kind: 'file', title: 'a.ts', path: '/repo/a.ts' }]
    })
    mgr.setWorkbenchState('s1', { open: true, tabs: [] })
    mgr.dispose()
    expect(layout.sessions.s1).toEqual({ open: true, tabs: [] })
  })

  it('flushes a pending panel write on dispose (quit must not lose the last toggle)', () => {
    bindAsRunning('s1')
    mgr.setWorkbenchState('s1', { open: false, tabs: [] })
    mgr.dispose()
    expect(layout.sessions.s1).toEqual({ open: false, tabs: [] })
  })

  it('keeps a Codex session’s panel state through rescans while Codex counts it, and drops it once Codex lets it go', async () => {
    const key = 'codex:local:thread-1'
    const members = new Set([key])
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
      additionalMembers: () => members
    })
    mgr.start()
    await vi.waitFor(() => expect(pushed.length).toBeGreaterThan(0))
    const state: SessionWorkbenchState = {
      open: true,
      tabs: [{ kind: 'web', title: 'app', url: 'http://localhost:5173/' }]
    }
    mgr.setWorkbenchState(key, state)

    const before = pushed.length
    mgr.onRemoteChanged()
    await vi.waitFor(() => expect(pushed.length).toBeGreaterThan(before))
    expect(mgr.workbenchState(key)).toEqual(state)

    members.delete(key)
    const later = pushed.length
    mgr.onRemoteChanged()
    await vi.waitFor(() => expect(pushed.length).toBeGreaterThan(later))
    expect(mgr.workbenchState(key)).toEqual(SEEDED)
  })

  it('drops a write for a session that has left the working set (the row stays gone)', () => {
    bindAsRunning('s1')
    mgr.setWorkbenchState('s1', {
      open: false,
      tabs: [{ kind: 'web', title: 'app', url: 'http://localhost:5173/' }]
    })
    mgr.dropOwnership('s1')
    expect(mgr.isMember('s1')).toBe(false)

    mgr.setWorkbenchState('s1', { open: true, tabs: [{ kind: 'web', title: 'late', url: 'u' }] })

    expect(mgr.isMember('s1')).toBe(false)
    mgr.dispose()
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

    expect(mgr.archiveSession('live-1')).toBe(false)
    mgr.dropOwnership('live-1')
    expect(layout.sessions['live-1']).toBeUndefined()
    expect(mgr.isMember('live-1')).toBe(false)

    const before = saves
    mgr.dropOwnership('live-1')
    expect(saves).toBe(before)
  })

  // CC§2
  it('GC spares a bound running session whose jsonl has not been born yet', async () => {
    writeJsonl(repo, 'anchor-1')
    layout.sessions['fresh-1'] = SEEDED
    bindings.set('fresh-1', 'tab-1')
    mgr.start()
    await vi.waitFor(() => expect(pushed.length).toBeGreaterThan(0))
    expect(layout.sessions['fresh-1']).toEqual(SEEDED)

    bindings.delete('fresh-1')
    mgr.onTrackerUpdate()
    await vi.waitFor(() => expect(layout.sessions['fresh-1']).toBeUndefined())
  })

  it('leaves the jsonl behind, so the evicted session is restorable history', async () => {
    writeJsonl(repo, 'gone-1')
    layout.sessions['gone-1'] = SEEDED
    mgr.start()
    await vi.waitFor(() => expect(latest(repo).rows.map((r) => r.id)).toEqual(['gone-1']))
    expect(latest(repo).workspace.hasHistory).toBe(false)

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
    bindings.set('bound-1', 'tab-1')
    mgr.start()
    await vi.waitFor(() => expect(pushed.length).toBeGreaterThan(0))

    expect(mgr.historyRows(repo).map((r) => r.id)).toEqual(['hist-new', 'hist-old'])
    expect(mgr.historyRows(path.join(root, 'never-pinned'))).toEqual([])
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
  const entry: SessionWorkbenchState = {
    open: true,
    tabs: [{ kind: 'web', title: 'app', url: 'http://localhost:5173/' }]
  }

  it('persists the carried panel state, and writes nothing on a /resume switch', () => {
    layout.sessions = { old: entry }

    mgr.onSessionRebind('old', 'fresh', 'clear')
    expect(layout.sessions).toEqual({ old: entry, fresh: entry })

    const saved = layout
    mgr.onSessionRebind('fresh', 'target', 'resume')
    expect(layout).toBe(saved)
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
    expect(list.map((w) => w.name)).toEqual(['alive'])
    expect(list[0].dir).toBe(wtDir)
  })
})

describe('WorkspaceManager: a rescan re-reads only the transcript heads that changed', () => {
  it('skips unchanged files, re-reads a grown one, never re-reads a settled head', async () => {
    const dir = path.join(projectsRoot, encodeCwd(repo))
    writeJsonl(repo, 'quiet-1')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(
      path.join(dir, 'grows-1.jsonl'),
      JSON.stringify({ type: 'user', cwd: repo, timestamp: '2026-08-08T11:00:00.000Z' }) + '\n'
    )
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
    bindings.set('quiet-1', 'tab-q')
    mgr.onTrackerUpdate()
    await vi.waitFor(() =>
      expect(latest(repo).rows.find((r) => r.id === 'quiet-1')?.running).toBe(true)
    )
    expect(jsonlOpened()).toEqual([])

    fs.appendFileSync(
      path.join(dir, 'grows-1.jsonl'),
      JSON.stringify({ type: 'summary', summary: 'later summary' }) + '\n'
    )
    bindings.set('grows-1', 'tab-g')
    mgr.onTrackerUpdate()
    await vi.waitFor(() => expect(titleOf('grows-1')).toBe('later summary'))
    expect(jsonlOpened()).toEqual(['grows-1.jsonl'])

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

  it('does not remember a head it could not open, so the next rescan reads it (else an unreadable, never-growing file keeps its age title for good)', async () => {
    const dir = path.join(projectsRoot, encodeCwd(repo))
    writeJsonl(repo, 'locked-1')
    const file = path.join(dir, 'locked-1.jsonl')
    fs.chmodSync(file, 0o000)
    layout.sessions['locked-1'] = SEEDED
    mgr.start()
    await vi.waitFor(() => expect(latest(repo).rows.map((r) => r.id)).toEqual(['locked-1']))
    expect(latest(repo).rows[0].title).not.toBe('a session')

    fs.chmodSync(file, 0o644)
    bindings.set('locked-1', 'tab-l')
    mgr.onTrackerUpdate()
    await vi.waitFor(() => expect(latest(repo).rows[0].title).toBe('a session'))
  })
})

describe('WorkspaceManager: discover (U-OB-01, the welcome’s folders-you-already-work-in list)', () => {
  function writeCwdlessJsonl(cwd: string, id: string): void {
    const dir = path.join(projectsRoot, encodeCwd(cwd))
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(
      path.join(dir, id + '.jsonl'),
      JSON.stringify({ type: 'summary', summary: 'a session' }) + '\n'
    )
  }

  // CC§2
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
    setMtime(sub, 'sub-1', 9000)

    writeJsonl(path.join(root, 'gone'), 'gone-1')

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
    const wtLive = path.join(c, '.claude', 'worktrees', 'y')
    fs.mkdirSync(wtLive, { recursive: true })
    writeJsonl(wtLive, 'wt-1')
    setMtime(wtLive, 'wt-1', 700)

    const d = path.join(root, 'd')
    fs.mkdirSync(d)
    writeJsonl(d, 'd-1')
    mgr.add(d)

    const e = path.join(root, 'e')
    fs.mkdirSync(e)
    writeCwdlessJsonl(e, 'e-1')

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
  it('U-WS-1: pins an ssh key verbatim, without touching a disk', () => {
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

  it('offers the worktrees the machine reported, named by their folder — this Mac cannot run git or stat there', async () => {
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

  // CC§2
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

  it('U-WS-2: runs no local repo probe at all for a remote workspace', async () => {
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

describe('remote workspace: pending launches', () => {
  it('a launch shows its pending row only under the machine it was started on, even when a local workspace has the same absolute path', async () => {
    const sameDirOnDevbox = `ssh://devbox${repo}`
    layout.workspaces = [{ path: repo }, { path: sameDirOnDevbox }]
    mgr = remoteMgr()
    mgr.start()
    mgr.launchStarted('tab-local', repo)
    mgr.launchStarted('tab-remote', repo, undefined, 'devbox')
    await vi.waitFor(() => {
      expect(latest(repo).rows.map((r) => r.id)).toEqual(['tab-local'])
      expect(latest(sameDirOnDevbox).rows.map((r) => r.id)).toEqual(['tab-remote'])
    })
  })

  it('a launch started on the typed path before the first heartbeat keeps its pending row once the path resolves to the real one', async () => {
    let real: string | undefined
    layout.workspaces = [{ path: RKEY }]
    mgr = remoteMgr({ remoteGit: () => ({ isGit: false, worktrees: [], real }) })
    mgr.start()
    mgr.launchStarted('tab-1', RPATH, undefined, 'devbox')
    await vi.waitFor(() => expect(latest(RKEY).rows.map((r) => r.id)).toEqual(['tab-1']))

    real = '/mnt/disk2/api'
    const before = pushed.length
    mgr.onRemoteChanged()
    await vi.waitFor(() => expect(pushed.length).toBeGreaterThan(before))
    expect(latest(RKEY).rows).toMatchObject([{ id: 'tab-1', pending: true }])
  })
})

describe('remote workspace: reading the mirror', () => {
  beforeEach(() => {
    layout.workspaces = [{ path: repo }, { path: RKEY }]
  })

  it('U-READ-1/U-READ-2: turns a mirrored transcript into a row whose resume is not blocked', async () => {
    writeMirrorJsonl('abc')
    layout.sessions = { abc: SEEDED }
    mgr = remoteMgr()
    mgr.start()
    await vi.waitFor(() => expect(latest(RKEY).rows.length).toBe(1))
    const row = latest(RKEY).rows[0]
    expect(row.id).toBe('abc')
    expect(row.invalidCwd).toBe(false)
    expect(row.cwd).toBe(RPATH)
  })

  it('U-READ-3/U-READ-4: keeps a mirrored session through GC while still collecting a local orphan', async () => {
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

  // CC§2
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

  it('gives a machine one target carrying every folder pinned on it, since the heartbeat mirrors once per host', async () => {
    layout.workspaces = [{ path: repo }, { path: RKEY }, { path: 'ssh://devbox/srv/www' }]
    mgr = remoteMgr()
    expect(mgr.remoteTargets()).toEqual([
      {
        host: 'devbox',
        paths: [RPATH, '/srv/www']
      }
    ])
  })

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
        host: 'local' as const,
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
        host: 'local' as const,
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
        host: 'local' as const,
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

// CC§2
describe('WorkspaceManager: a running session that moved', () => {
  let live: Map<string, LiveSession>

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

  function liveMgr(extra: Record<string, unknown> = {}): WorkspaceManager {
    return remoteMgr({ liveSessions: () => live, ...extra })
  }

  beforeEach(() => {
    live = new Map()
  })

  // CC§3
  it('takes the live worktree of a session claude moved, and leaves the others (a resumed, unmoved one included) alone', async () => {
    const wt = path.join(repo, '.claude', 'worktrees', 'eng')
    fs.mkdirSync(wt, { recursive: true })
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
    live.set('left-1', { treeRoot: repo, relocated: true })
    live.set('in-1', { treeRoot: wt, worktree: 'eng', relocated: true })
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
    const gone = path.join(repo, '.claude', 'worktrees', 'pulled')
    writeJsonl(repo, 'live-2')
    layout = { ...layout, workspaces: [{ path: repo }], sessions: { 'live-2': SEEDED } }
    bindings.set('live-2', 'tab-z')
    live.set('live-2', { treeRoot: gone, worktree: 'pulled', relocated: true })
    mgr = liveMgr()
    mgr.start()
    await vi.waitFor(() => expect(latest(repo).rows.length).toBe(1))
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

  // CC§4
  it('a stopped session that left its worktree is back on main, resumable from the root, even with the worktree gone', async () => {
    const wt = path.join(repo, '.claude', 'worktrees', 'gone')
    const dir = path.join(projectsRoot, encodeCwd(repo))
    const id = 'exited-1'
    fs.mkdirSync(dir, { recursive: true })
    const records = [
      { type: 'user', cwd: wt, timestamp: '2026-09-10T11:00:00.000Z', sessionId: id },
      {
        type: 'worktree-state',
        sessionId: id,
        worktreeSession: {
          originalCwd: repo,
          worktreePath: wt,
          worktreeName: 'gone',
          worktreeBranch: 'worktree-gone',
          originalHeadCommit: 'abc123'
        }
      },
      { type: 'relocated', sessionId: id, relocatedCwd: repo },
      { type: 'worktree-state', worktreeSession: null, sessionId: id }
    ]
    fs.writeFileSync(
      path.join(dir, id + '.jsonl'),
      records.map((r) => JSON.stringify(r)).join('\n') + '\n'
    )
    layout = { ...layout, workspaces: [{ path: repo }], sessions: { [id]: SEEDED } }
    mgr = liveMgr()
    mgr.start()
    await vi.waitFor(() => expect(latest(repo).rows.length).toBe(1))
    const row = latest(repo).rows[0]
    expect(row).toMatchObject({ worktree: 'main', cwd: repo, invalidCwd: false })
    expect(row.worktreeState).toBeUndefined()
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
    expect(latest(RKEY).rows[0]).toMatchObject({ worktree: 'feature', revealDir: wtPath })
  })
})
