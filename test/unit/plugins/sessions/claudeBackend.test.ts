import { describe, it, expect, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

vi.mock('electron', async () => {
  const nfs = await import('node:fs')
  const nos = await import('node:os')
  const npath = await import('node:path')
  const base = nfs.mkdtempSync(npath.join(nos.tmpdir(), 'koloft-backend-'))
  return { app: { getPath: () => base, getName: () => 'koloft-dev', isPackaged: false } }
})

import {
  ClaudeBackend,
  rebuildWorktree,
  type ClaudeBackendDeps
} from '../../../../src/agents/claude/main/backend'
import { GIT_CALL_TIMEOUT_MS, localHost } from '../../../../src/main/host/localHost'
import { GithubRepos } from '../../../../src/main/githubRepos'
import { gitOnPath, realGit, restorePath, seedRepo } from '../../helpers/gitShim'
import { mirrorHookDir } from '../../../../src/main/remote/paths'
import { START_IN_STATUS_LOG } from '../../../../src/plugins/sessions/main/hooks'

function fakeTracker(): ClaudeBackendDeps['tracker'] {
  const tracked = new Map<string, { sessionId: string }>()
  return {
    track: (tabId: string) => void tracked.set(tabId, { sessionId: '' }),
    infoOf: (tabId: string) => tracked.get(tabId),
    bindSession: (tabId: string, _transcript: string, sessionId: string) => {
      const t = tracked.get(tabId)
      if (t) t.sessionId = sessionId
    },
    remoteOf: () => undefined,
    list: () => []
  } as unknown as ClaudeBackendDeps['tracker']
}

const NOTES_LONG_SETTLED_BEFORE_THE_WATCH_MS = 1500
const tabId = 'pty-x-1'
const sessionId = '3c4ac765-c402-4d6d-88ac-dca81e2a35f1'

function backendWithDirs(): {
  backend: ClaudeBackend
  events: unknown[]
  agentExits(): void
  writeHookStart(): void
  writeTurn(): void
  writePrompt(): void
  writeShimRegistration(): void
  watch(): void
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-backend-dirs-'))
  const shimRegDir = path.join(root, 'sessions')
  const hookRegDir = path.join(root, 'hook-sessions')
  fs.mkdirSync(shimRegDir)
  fs.mkdirSync(hookRegDir)
  const events: unknown[] = []
  const pty = { alive: true }
  const backend = new ClaudeBackend({
    pty: { get: () => pty, pidOf: () => 4242, clearResumeIntent: () => {} },
    tracker: fakeTracker(),
    store: () => null,
    events: (id: string, event: unknown) => events.push([id, event])
  } as unknown as ClaudeBackendDeps)
  const statusLog = path.join(hookRegDir, `${tabId}.status.jsonl`)
  const logLine = (report: object): void =>
    fs.appendFileSync(statusLog, `${JSON.stringify({ tabId, sessionId, ...report })}\n`)
  return {
    backend,
    events,
    agentExits: () => {
      pty.alive = false
      backend.onPtyExit(tabId, true)
    },
    writeHookStart: () => {
      const note = { event: 'start', source: 'startup', cwd: root, [START_IN_STATUS_LOG]: true }
      fs.writeFileSync(
        path.join(hookRegDir, `${tabId}.json`),
        JSON.stringify({ tabId, sessionId, ...note })
      )
      logLine(note)
    },
    writeTurn: () => {
      logLine({ event: 'prompt' })
      logLine({ event: 'stop' })
    },
    writePrompt: () => logLine({ event: 'prompt' }),
    writeShimRegistration: () =>
      fs.writeFileSync(
        path.join(shimRegDir, `${sessionId}.json`),
        JSON.stringify({ tabId, regId: sessionId, sessionId, cwd: root, pid: 4242 })
      ),
    watch: () => {
      backend.watchShimRegistrations(shimRegDir)
      backend.watchLocalHooks(hookRegDir)
    }
  }
}

const MACHINE_TABS = {
  'pty-a': { host: 'devbox', tmuxName: 'k-sa' },
  'pty-b': { host: 'devbox', tmuxName: 'k-sb' },
  'pty-c': { host: 'otherbox', tmuxName: 'k-sc' }
} as Record<string, { host: string; tmuxName: string }>

function machineBackend(): {
  boundTo: Map<string, string>
  binds: [string, string][]
  appendLog(name: string, lines: unknown[]): void
} {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-backend-machine-'))
  const boundTo = new Map(Object.keys(MACHINE_TABS).map((id) => [id, `sid-of-${id}`]))
  const binds: [string, string][] = []
  const backend = new ClaudeBackend({
    pty: {
      get: (id: string) => (MACHINE_TABS[id] ? { alive: true } : undefined),
      clearResumeIntent: () => {}
    },
    tracker: {
      infoOf: (id: string) => (boundTo.has(id) ? { sessionId: boundTo.get(id) } : undefined),
      bindSession: (id: string, _transcript: string, sid: string) => {
        boundTo.set(id, sid)
        binds.push([id, sid])
      },
      remoteOf: (id: string) => MACHINE_TABS[id],
      setRemoteTmuxName: () => {},
      list: () => Object.keys(MACHINE_TABS).map((tabId) => ({ tabId, alive: true }))
    },
    remoteTargets: () => [{ host: 'devbox', paths: [] }],
    sessionRebound: () => {},
    store: () => ({
      onSessionStart: () => {},
      onSessionBound: () => {},
      dropOwnership: () => {}
    }),
    userData: () => userData,
    events: () => {}
  } as unknown as ClaudeBackendDeps)
  backend.watchRemoteHookMirrors()
  const mirrorDir = mirrorHookDir(userData, 'devbox')
  return {
    boundTo,
    binds,
    appendLog: (name, lines) =>
      fs.appendFileSync(
        path.join(mirrorDir, name),
        lines.map((l) => `${JSON.stringify(l)}\n`).join('')
      )
  }
}

describe('ClaudeBackend: the hook mirror of a session on a remote machine', () => {
  // CC§1
  it("does not bind a tab again to the session it already runs when a mirrored status log is read from its start again, as after a restart, yet still follows that session's /clear", async () => {
    const m = machineBackend()
    m.appendLog('pty-gone.status.jsonl', [
      {
        tabId: 'pty-gone',
        event: 'start',
        source: 'startup',
        sessionId: 'sid-of-pty-a',
        tmux: 'k-sa'
      },
      { tabId: 'pty-gone', event: 'start', source: 'clear', sessionId: 'sid-new', tmux: 'k-sa' }
    ])
    await vi.waitFor(() => expect(m.boundTo.get('pty-a')).toBe('sid-new'), { timeout: 5000 })
    expect(m.binds).toEqual([['pty-a', 'sid-new']])
  })
})

describe('ClaudeBackend: waiting for a remote session to end before its folder is tidied (#22)', () => {
  const REMOTE_EXIT_WAIT_MS = 10_000

  function machine(): {
    backend: ClaudeBackend
    sync: { connected: boolean; alive: Set<string>; pokes: string[] }
  } {
    const sync = { connected: true, alive: new Set(['sid-1']), pokes: [] as string[] }
    const backend = new ClaudeBackend({
      remoteSync: () => ({
        pokeNow: (host: string) => void sync.pokes.push(host),
        connected: () => sync.connected,
        alive: () => sync.alive
      })
    } as unknown as ClaudeBackendDeps)
    return { backend, sync }
  }

  it('asks the machine at once, and answers "gone" as soon as the session leaves its list', async () => {
    vi.useFakeTimers()
    try {
      const m = machine()
      const answer = m.backend.waitRemoteGone('devbox', 'sid-1')
      expect(m.sync.pokes).toEqual(['devbox'])
      await vi.advanceTimersByTimeAsync(2_000)
      m.sync.alive.delete('sid-1')
      await vi.advanceTimersByTimeAsync(1_000)
      await expect(answer).resolves.toBe('gone')
    } finally {
      vi.useRealTimers()
    }
  })

  it('answers "alive" when the session is still there after ten seconds, and "unreachable" when the machine never answered', async () => {
    vi.useFakeTimers()
    try {
      const alive = machine()
      const stillThere = alive.backend.waitRemoteGone('devbox', 'sid-1')
      const down = machine()
      down.sync.connected = false
      down.sync.alive.clear()
      const neverAnswered = down.backend.waitRemoteGone('devbox', 'sid-1')
      await vi.advanceTimersByTimeAsync(REMOTE_EXIT_WAIT_MS + 1_000)
      await expect(stillThere).resolves.toBe('alive')
      await expect(neverAnswered).resolves.toBe('unreachable')
    } finally {
      vi.useRealTimers()
    }
  })
})

const PAST_A_STATUS_LOG_POLL_MS = 1500

describe('ClaudeBackend: a local tab binds once both of its start notes are on disk', () => {
  it("binds the session when claude's SessionStart is read before the shim's registration of the tab", async () => {
    const t = backendWithDirs()
    t.watch()
    t.writeHookStart()
    await new Promise((r) => setTimeout(r, 300))
    expect(t.events).toEqual([])
    t.writeShimRegistration()
    await vi.waitFor(() => expect(t.events).toEqual([[tabId, { type: 'bound', key: sessionId }]]))
  })

  // CC§1
  it('applies a start written to both files once, and a first turn read before the tab is registered only after it, in the order claude wrote them', async () => {
    const t = backendWithDirs()
    t.watch()
    t.writeHookStart()
    t.writeTurn()
    await new Promise((r) => setTimeout(r, PAST_A_STATUS_LOG_POLL_MS))
    expect(t.events).toEqual([])
    t.writeShimRegistration()
    const inOrder = [
      [tabId, { type: 'bound', key: sessionId }],
      [tabId, { type: 'prompt' }],
      [tabId, { type: 'stop', reported: undefined }]
    ]
    await vi.waitFor(() => expect(t.events).toEqual(inOrder))
    t.writePrompt()
    await vi.waitFor(() => expect(t.events).toEqual([...inOrder, [tabId, { type: 'prompt' }]]))
  })

  it('reports a tab whose claude died without an end report as exited, and takes no turn from status lines read after that, which would turn its exited mark back into a finished turn', async () => {
    const t = backendWithDirs()
    t.watch()
    t.writeShimRegistration()
    t.writeHookStart()
    t.writeTurn()
    await vi.waitFor(() => expect(t.events).toHaveLength(3), { timeout: 5000 })
    t.agentExits()
    const exited = [tabId, { type: 'exited', clean: false, sessionId }]
    expect(t.events.slice(3)).toEqual([exited])
    t.writeHookStart()
    t.writeTurn()
    await new Promise((r) => setTimeout(r, PAST_A_STATUS_LOG_POLL_MS))
    expect(t.events.slice(3)).toEqual([exited])
  })

  // PLATFORM§28
  it('binds the session when the folder watch never reports either note', async () => {
    const t = backendWithDirs()
    t.writeShimRegistration()
    t.writeHookStart()
    await new Promise((r) => setTimeout(r, NOTES_LONG_SETTLED_BEFORE_THE_WATCH_MS))
    t.watch()
    await vi.waitFor(() => expect(t.events).toEqual([[tabId, { type: 'bound', key: sessionId }]]), {
      timeout: 5000
    })
  })
})

describe('ClaudeBackend: resuming a session on a remote machine into a worktree another Claude Code tab there works in', () => {
  const SID = '0d7c1f40-1a5e-4b8e-9a51-6f0d2c3e4b5a'
  const TREE = '/srv/repo/.claude/worktrees/w1'

  function planWith(other: { cwd: string; treeRoot: string; alive: boolean; sessionId?: string }) {
    const backend: ClaudeBackend = new ClaudeBackend({
      tracker: {
        list: () => [
          {
            tabId: 'other-tab',
            sessionId: 'other-session',
            title: 'Other session at work',
            remote: { host: 'lab' },
            ...other
          }
        ],
        remoteOf: () => undefined
      },
      resumeProbes: { occupantOf: (dir: string) => backend.occupantOf(dir) },
      store: () => ({
        findRow: (id: string) =>
          id === SID
            ? {
                id: SID,
                cwd: TREE,
                worktreeState: {
                  worktreePath: TREE,
                  worktreeName: 'w1',
                  originalCwd: '/srv/repo',
                  worktreeBranch: 'worktree-w1'
                }
              }
            : undefined,
        workspaceOf: () => 'ssh://lab/srv/repo',
        bucketDirOf: () => undefined
      }),
      hosts: {
        of: () => ({
          dirExists: async () => true,
          keyed: (p: string) => `ssh://lab${p}`
        })
      }
    } as unknown as ClaudeBackendDeps)
    return backend.resumePlan(SID)
  }

  it('asks where to resume while that tab works in the worktree, also after it moved into a subfolder of it, and not once its tab has exited', async () => {
    await expect(planWith({ cwd: TREE, treeRoot: TREE, alive: true })).resolves.toMatchObject({
      action: 'dialog',
      occupiedBy: 'Other session at work'
    })
    await expect(
      planWith({ cwd: `${TREE}/src`, treeRoot: TREE, alive: true })
    ).resolves.toMatchObject({ action: 'dialog', occupiedBy: 'Other session at work' })
    await expect(
      planWith({ cwd: `${TREE}/src`, treeRoot: TREE, alive: false })
    ).resolves.toMatchObject({ action: 'direct' })
  })

  it('does not count its own exited tab in the worktree', async () => {
    await expect(
      planWith({ cwd: TREE, treeRoot: TREE, alive: false, sessionId: SID })
    ).resolves.toMatchObject({ action: 'direct' })
  })
})

describe('ClaudeBackend: the resume check before a restart', () => {
  it('takes a transcript the session list already found without listing every project folder, and asks the tracker once that file is gone', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-backend-listed-'))
    const listed = path.join(dir, `${sessionId}.jsonl`)
    fs.writeFileSync(listed, '{}\n')
    const swept: string[] = []
    const backend = new ClaudeBackend({
      tracker: {
        transcriptExists: (key: string) => {
          swept.push(key)
          return true
        }
      },
      store: () => ({
        transcriptFileOf: (key: string) => (key === sessionId ? listed : undefined)
      })
    } as unknown as ClaudeBackendDeps)
    const listedFolders = vi.spyOn(fs, 'readdirSync')

    expect(backend.transcriptExists(sessionId)).toBe(true)
    expect(swept).toEqual([])
    expect(listedFolders).not.toHaveBeenCalled()

    fs.rmSync(listed)
    expect(backend.transcriptExists(sessionId)).toBe(true)
    expect(swept).toEqual([sessionId])
    listedFolders.mockRestore()
  })
})

const CHECKOUT_OF_A_BIG_REPO_MS = GIT_CALL_TIMEOUT_MS + 500

describe('ClaudeBackend: rebuilding a missing worktree on resume', () => {
  it(
    'rebuilds the worktree of a repository whose checkout takes longer than a quick git call is given',
    async () => {
      const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-rebuild-')))
      const root = path.join(tmp, 'repo')
      seedRepo(root)
      gitOnPath(
        tmp,
        `#!/bin/sh\ncase " $* " in *" worktree add "*) "${realGit()}" "$@" || exit $?; exec sleep ${CHECKOUT_OF_A_BIG_REPO_MS / 1000} ;; esac\nexec "${realGit()}" "$@"\n`
      )
      const worktreePath = path.join(root, '.claude', 'worktrees', 'wt')
      try {
        const rebuilt = await rebuildWorktree(
          { worktreePath, branch: 'worktree-wt', baseRef: 'main' },
          localHost(new GithubRepos({}), {} as never),
          undefined
        )
        expect(rebuilt).toBe(true)
        expect(fs.existsSync(worktreePath)).toBe(true)
      } finally {
        restorePath()
        fs.rmSync(tmp, { recursive: true, force: true })
      }
    },
    CHECKOUT_OF_A_BIG_REPO_MS * 3
  )
})
