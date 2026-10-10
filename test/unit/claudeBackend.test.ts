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

const MACHINE_TABS = {
  'pty-a': { host: 'devbox', tmuxName: 'k-sa' },
  'pty-b': { host: 'devbox', tmuxName: 'k-sb' },
  'pty-c': { host: 'otherbox', tmuxName: 'k-sc' }
} as Record<string, { host: string; tmuxName: string }>

function machineBackend(): {
  boundTo: Map<string, string>
  answeredFor: string[]
  sent: [string, string, string][]
  drop(name: string, body: unknown): void
} {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-backend-machine-'))
  const boundTo = new Map(Object.keys(MACHINE_TABS).map((id) => [id, `sid-of-${id}`]))
  const answeredFor: string[] = []
  const sent: [string, string, string][] = []
  const backend = new ClaudeBackend({
    pty: { get: (id: string) => (MACHINE_TABS[id] ? {} : undefined), clearResumeIntent: () => {} },
    hosts: {
      machine: (host: string) => ({
        answerAgent: async (id: string, reply: string) => void sent.push([host, id, reply])
      })
    },
    tracker: {
      infoOf: (id: string) => (boundTo.has(id) ? { sessionId: boundTo.get(id) } : undefined),
      bindSession: (id: string, _transcript: string, sid: string) => void boundTo.set(id, sid),
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
    events: () => {}
  } as unknown as ClaudeBackendDeps)
  backend.agentReply = async (tabId) => {
    answeredFor.push(tabId)
    return answered(`for ${tabId}`)
  }
  backend.watchRemoteHookMirrors()
  const mirrorDir = mirrorHookDir(userData, 'devbox')
  return {
    boundTo,
    answeredFor,
    sent,
    drop: (name, body) => fs.writeFileSync(path.join(mirrorDir, name), JSON.stringify(body))
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
