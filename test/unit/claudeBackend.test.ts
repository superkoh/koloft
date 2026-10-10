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
