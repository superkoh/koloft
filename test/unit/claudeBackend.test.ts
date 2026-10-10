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
import { watchMirroredAgentRequests } from '../../src/main/remote/agentMirror'
import { mirrorHookDir } from '../../src/main/remote/paths'

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
  writeHookStart(): void
  writeShimRegistration(): void
  watch(): void
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-backend-dirs-'))
  const shimRegDir = path.join(root, 'sessions')
  const hookRegDir = path.join(root, 'hook-sessions')
  fs.mkdirSync(shimRegDir)
  fs.mkdirSync(hookRegDir)
  const events: unknown[] = []
  const backend = new ClaudeBackend({
    pty: { get: () => ({}), pidOf: () => 4242, clearResumeIntent: () => {} },
    tracker: fakeTracker(),
    workspaces: () => null,
    events: (id: string, event: unknown) => events.push([id, event])
  } as unknown as ClaudeBackendDeps)
  return {
    backend,
    events,
    writeHookStart: () =>
      fs.writeFileSync(
        path.join(hookRegDir, `${tabId}.json`),
        JSON.stringify({ tabId, event: 'start', source: 'startup', sessionId, cwd: root })
      ),
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

function machineBackend(tmuxOfTab: Record<string, string>): {
  backend: ClaudeBackend
  boundTo: Map<string, string>
  events: unknown[]
  mirrorDir: string
} {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-backend-machine-'))
  const boundTo = new Map(Object.keys(tmuxOfTab).map((id) => [id, `sid-of-${id}`]))
  const events: unknown[] = []
  const backend = new ClaudeBackend({
    pty: { get: (id: string) => (tmuxOfTab[id] ? {} : undefined), clearResumeIntent: () => {} },
    tracker: {
      infoOf: (id: string) => (boundTo.has(id) ? { sessionId: boundTo.get(id) } : undefined),
      bindSession: (id: string, _transcript: string, sid: string) => void boundTo.set(id, sid),
      remoteOf: (id: string) =>
        tmuxOfTab[id] ? { host: 'devbox', tmuxName: tmuxOfTab[id] } : undefined,
      setRemoteTmuxName: () => {},
      list: () => Object.keys(tmuxOfTab).map((tabId) => ({ tabId, alive: true }))
    },
    workspaces: () => ({
      remoteTargets: () => [{ host: 'devbox', paths: [] }],
      onSessionStart: () => {},
      onSessionRebind: () => {},
      onSessionBound: () => {},
      dropOwnership: () => {}
    }),
    userData: () => userData,
    events: (id: string, event: unknown) => events.push([id, event])
  } as unknown as ClaudeBackendDeps)
  return { backend, boundTo, events, mirrorDir: mirrorHookDir(userData, 'devbox') }
}

describe('ClaudeBackend: koloft requests from a session on a remote machine', () => {
  it('a koloft request the hook mirror brings back goes to the koloft answer, and never rebinds the tab it names', async () => {
    const m = machineBackend({ 'pty-a': 'k-sa', 'pty-b': 'k-sb' })
    const asked: [string, string][] = []
    m.backend.watchMirroredAgent = (host, dir) =>
      watchMirroredAgentRequests(dir, (id) => asked.push([host, id]))
    m.backend.watchRemoteHookMirrors()
    const drop = (name: string, body: unknown): void =>
      fs.writeFileSync(path.join(m.mirrorDir, name), JSON.stringify(body))

    drop('req-r1.json', { tabId: 'pty-a', tmux: 'k-sa', argv: ['help'], cwd: '/home/u' })
    drop('res-r0.json', { exit: 0, text: 'old answer' })
    await vi.waitFor(() => expect(asked).toEqual([['devbox', 'r1']]), { timeout: 5000 })
    drop('pty-b.json', { tabId: 'pty-b', event: 'start', source: 'clear', sessionId: 'sid-new' })
    await vi.waitFor(() => expect(m.boundTo.get('pty-b')).toBe('sid-new'), { timeout: 5000 })

    expect(m.boundTo.get('pty-a')).toBe('sid-of-pty-a')
  })

  it('finds the calling tab by its tmux session before its tab id, which a Koloft restart can hand to another tab, and only among the tabs on the machine the request came from', () => {
    const { backend } = machineBackend({ 'pty-a': 'k-sa', 'pty-b': 'k-sb' })
    expect(backend.remoteCaller('devbox', { tabId: 'pty-b', tmux: 'k-sa' })).toBe('pty-a')
    expect(backend.remoteCaller('devbox', { tabId: 'pty-b', tmux: '' })).toBe('pty-b')
    expect(backend.remoteCaller('elsewhere', { tabId: 'pty-a', tmux: 'k-sa' })).toBeUndefined()
  })
})

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
