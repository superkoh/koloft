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

describe('ClaudeBackend: a local tab binds whichever of its two start notes Koloft reads first', () => {
  it("binds the session when claude's SessionStart is read before the shim's registration of the tab", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-backend-dirs-'))
    const shimRegDir = path.join(root, 'sessions')
    const hookRegDir = path.join(root, 'hook-sessions')
    fs.mkdirSync(shimRegDir)
    fs.mkdirSync(hookRegDir)
    const tabId = 'pty-x-1'
    const sessionId = '3c4ac765-c402-4d6d-88ac-dca81e2a35f1'
    const events: unknown[] = []
    const backend = new ClaudeBackend({
      pty: { get: () => ({}), pidOf: () => 4242, clearResumeIntent: () => {} },
      tracker: fakeTracker(),
      workspaces: () => null,
      events: (id: string, event: unknown) => events.push([id, event])
    } as unknown as ClaudeBackendDeps)
    backend.watchShimRegistrations(shimRegDir)
    backend.watchLocalHooks(hookRegDir)

    fs.writeFileSync(
      path.join(hookRegDir, `${tabId}.json`),
      JSON.stringify({ tabId, event: 'start', source: 'startup', sessionId, cwd: root })
    )
    await new Promise((r) => setTimeout(r, 300))
    expect(events).toEqual([])
    fs.writeFileSync(
      path.join(shimRegDir, `${sessionId}.json`),
      JSON.stringify({ tabId, regId: sessionId, sessionId, cwd: root, pid: 4242 })
    )

    await vi.waitFor(() => expect(events).toEqual([[tabId, { type: 'bound', key: sessionId }]]))
  })
})
