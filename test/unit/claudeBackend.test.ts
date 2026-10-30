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

import { ClaudeBackend, type ClaudeBackendDeps } from '../../src/main/backends/claude'
import { answered, replyJson } from '../../src/main/agentRequests'
import { mirrorHookDir } from '../../src/main/remote/paths'
import { START_IN_STATUS_LOG } from '../../src/main/hooks'

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
  statusLog: string
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
    workspaces: () => null,
    events: (id: string, event: unknown) => events.push([id, event])
  } as unknown as ClaudeBackendDeps)
  const statusLog = path.join(hookRegDir, `${tabId}.status.jsonl`)
  const logLine = (report: object): void =>
    fs.appendFileSync(statusLog, `${JSON.stringify({ tabId, sessionId, ...report })}\n`)
  return {
    backend,
    events,
    statusLog,
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

const CODEX_TABS = { 'pty-cx': 'devbox', 'pty-cy': 'otherbox' } as Record<string, string>

const WORKBENCH_SHELLS = {
  'pty-wa': { util: true, ownerTabId: 'pty-a' },
  'pty-wcx': { util: true, ownerTabId: 'pty-cx' },
  'pty-wgone': { util: true, ownerTabId: 'pty-gone' }
} as Record<string, { util: boolean; ownerTabId: string }>

function machineBackend(): {
  boundTo: Map<string, string>
  binds: [string, string][]
  answeredFor: (string | undefined)[]
  sent: [string, string, string][]
  drop(name: string, body: unknown): void
  appendLog(name: string, lines: unknown[]): void
} {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-backend-machine-'))
  const boundTo = new Map(Object.keys(MACHINE_TABS).map((id) => [id, `sid-of-${id}`]))
  const binds: [string, string][] = []
  const answeredFor: (string | undefined)[] = []
  const sent: [string, string, string][] = []
  const backend = new ClaudeBackend({
    pty: {
      get: (id: string) =>
        WORKBENCH_SHELLS[id] ?? (MACHINE_TABS[id] || CODEX_TABS[id] ? { alive: true } : undefined),
      clearResumeIntent: () => {}
    },
    machineOfTab: (id: string) => MACHINE_TABS[id]?.host ?? CODEX_TABS[id],
    hosts: {
      machine: (host: string) => ({
        answerAgent: async (id: string, reply: string) => void sent.push([host, id, reply])
      })
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
    workspaces: () => ({
      remoteTargets: () => [{ host: 'devbox', paths: [] }],
      onSessionStart: () => {},
      onSessionRebind: () => {},
      onSessionBound: () => {},
      dropOwnership: () => {}
    }),
    userData: () => userData,
    events: () => {},
    machineOf: (id: string) => MACHINE_TABS[id]?.host
  } as unknown as ClaudeBackendDeps)
  backend.agentReply = async (tabId) => {
    answeredFor.push(tabId)
    return answered(`for ${tabId}`)
  }
  backend.watchRemoteHookMirrors()
  const mirrorDir = mirrorHookDir(userData, 'devbox')
  return {
    boundTo,
    binds,
    answeredFor,
    sent,
    drop: (name, body) => fs.writeFileSync(path.join(mirrorDir, name), JSON.stringify(body)),
    appendLog: (name, lines) =>
      fs.appendFileSync(
        path.join(mirrorDir, name),
        lines.map((l) => `${JSON.stringify(l)}\n`).join('')
      )
  }
}

const A_FEW_MIRROR_PULLS_MS = 1500
const request = (tabId: string, tmux: string): unknown => ({
  tabId,
  tmux,
  argv: ['help'],
  cwd: '/'
})

describe('ClaudeBackend: koloft requests from a session on a remote machine', () => {
  // PLATFORM§34
  it('answers a request the hook mirror brings back once on the machine, though every pull writes it again, and never rebinds the tab it names', async () => {
    const m = machineBackend()
    m.drop('req-r1.json', request('pty-a', 'k-sa'))
    m.drop('res-r0.json', { exit: 0, text: 'an answer the mirror pulled back' })
    await vi.waitFor(() => expect(m.sent).toHaveLength(1), { timeout: 5000 })
    for (let i = 0; i < 3; i++) {
      await new Promise((r) => setTimeout(r, A_FEW_MIRROR_PULLS_MS / 3))
      m.drop('req-r1.json', request('pty-a', 'k-sa'))
    }
    m.drop('pty-b.json', { tabId: 'pty-b', event: 'start', source: 'clear', sessionId: 'sid-new' })
    await vi.waitFor(() => expect(m.boundTo.get('pty-b')).toBe('sid-new'), { timeout: 5000 })

    expect(m.sent).toEqual([['devbox', 'r1', replyJson(answered('for pty-a'))]])
    expect(m.boundTo.get('pty-a')).toBe('sid-of-pty-a')
  })

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

  it('finds the calling tab by its tmux session before its tab id, which a Koloft restart can hand to another tab, and leaves a request from no tab of its own on that machine unanswered, for the Koloft that owns it', async () => {
    const m = machineBackend()
    m.drop('req-r2.json', request('pty-c', 'k-sc'))
    m.drop('req-r3.json', request('pty-gone', 'k-gone'))
    m.drop('req-r4.json', request('pty-b', 'k-sa'))
    m.drop('req-r5.json', request('pty-b', ''))
    await vi.waitFor(() => expect(m.sent).toHaveLength(2), { timeout: 5000 })
    await new Promise((r) => setTimeout(r, A_FEW_MIRROR_PULLS_MS))

    expect(m.sent.map(([, id]) => id).sort()).toEqual(['r4', 'r5'])
    expect(m.answeredFor.sort()).toEqual(['pty-a', 'pty-b'])
  })

  // ADR-0039
  it('answers a request from a Codex tab on that machine, which names its tab and no tmux session, and leaves one from a Codex tab on another machine unanswered', async () => {
    const m = machineBackend()
    m.drop('req-r6.json', request('pty-cy', ''))
    m.drop('req-r7.json', request('pty-cx', ''))
    await vi.waitFor(() => expect(m.sent).toHaveLength(1), { timeout: 5000 })
    await new Promise((r) => setTimeout(r, A_FEW_MIRROR_PULLS_MS))

    expect(m.sent).toEqual([['devbox', 'r7', replyJson(answered('for pty-cx'))]])
  })

  it('answers a request from a Workbench shell on that machine as the session tab that owns the shell, Claude or Codex, and one whose owner is gone at once, with no tab, instead of leaving it to time out', async () => {
    const m = machineBackend()
    m.drop('req-r8.json', request('pty-wa', ''))
    m.drop('req-r9.json', request('pty-wcx', ''))
    m.drop('req-r10.json', request('pty-wgone', ''))
    await vi.waitFor(() => expect(m.sent).toHaveLength(3), { timeout: 5000 })

    expect(Object.fromEntries(m.sent.map(([, id, reply]) => [id, reply]))).toEqual({
      r8: replyJson(answered('for pty-a')),
      r9: replyJson(answered('for pty-cx')),
      r10: replyJson(answered('for undefined'))
    })
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

  it('reports a tab whose claude died without an end report as exited, and takes no turn from its status log read again from the start after that, as a poll that caught the log before it was removed does', async () => {
    const t = backendWithDirs()
    t.watch()
    t.writeShimRegistration()
    t.writeHookStart()
    t.writeTurn()
    await vi.waitFor(() => expect(t.events).toHaveLength(3))
    t.agentExits()
    const exited = [tabId, { type: 'exited', clean: false, sessionId }]
    expect(t.events.slice(3)).toEqual([exited])
    await vi.waitFor(() => expect(fs.existsSync(t.statusLog)).toBe(false))
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
