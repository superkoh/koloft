import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { Conductors, conductorFolder, type ConductorDeps } from '../../src/main/discord/conductors'
import type { DiscordSettings } from '@shared/types'

const LINK = 'https://discord.com/channels/100/200'
const DEADLINE_MS = 1000

let userData: string
let saved: DiscordSettings
let started: { cwd: string; role: string }[]
let resumed: string[]
let killed: string[]
let toasts: string[]
let transcripts: Set<string>
let release: () => void

function make(): Conductors {
  const deps: ConductorDeps = {
    userData,
    load: () => saved,
    save: (d) => void (saved = d),
    isPinned: (scope) => scope === '/ws/a',
    backendEnabled: () => true,
    tabAlive: (tabId) => !killed.includes(tabId),
    liveTabFor: () => undefined,
    runningElsewhere: async () => false,
    transcriptExists: async (_backend, key) => transcripts.has(key),
    start: async (l) => {
      started.push({ cwd: l.cwd, role: l.role })
      await new Promise<void>((r) => (release = r))
      return `tab-${started.length}`
    },
    resume: async (l) => {
      resumed.push(l.key)
      return `tab-resumed-${l.key}`
    },
    kill: (tabId) => void killed.push(tabId),
    rowsChanged: () => {},
    toast: (t) => void toasts.push(t),
    bindDeadlineMs: DEADLINE_MS
  }
  return new Conductors(deps)
}

beforeEach(() => {
  userData = fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-conductors-'))
  saved = { conductorsFolded: true, bindings: [] }
  started = []
  resumed = []
  killed = []
  toasts = []
  transcripts = new Set()
  release = () => {}
})

afterEach(() => {
  vi.useRealTimers()
  fs.rmSync(userData, { recursive: true, force: true })
})

describe('Conductors', () => {
  it('a second open while the first is still starting waits for it and starts nothing new', async () => {
    const c = make()
    expect(c.save({ scope: 'global', backend: 'claude', link: LINK })).toEqual({ ok: true })
    const id = c.bindings()[0].id
    const first = c.open(id)
    const second = c.open(id)
    await vi.waitFor(() => expect(started).toHaveLength(1))
    release()
    expect(await first).toEqual({ ok: true, tabId: 'tab-1' })
    expect(await second).toEqual({ ok: true, tabId: 'tab-1' })
    expect(await c.open(id)).toEqual({ ok: true, tabId: 'tab-1' })
    expect(started).toHaveLength(1)
  })

  it('the global conductor starts in its own folder under userData, told its role', async () => {
    const c = make()
    c.save({ scope: 'global', backend: 'claude', link: LINK })
    const opening = c.open(c.bindings()[0].id)
    await vi.waitFor(() => expect(started).toHaveLength(1))
    release()
    await opening
    expect(started[0].cwd).toBe(path.join(userData, 'conductors', 'global'))
    expect(fs.statSync(started[0].cwd).isDirectory()).toBe(true)
    expect(started[0].role).toMatch(/^You are Koloft's conductor for all workspaces\./)
  })

  it('binding follows the tab: every session it binds stays hidden and the newest is the one to resume', async () => {
    const c = make()
    c.save({ scope: '/ws/a', backend: 'claude', link: LINK })
    const id = c.bindings()[0].id
    const opening = c.open(id)
    await vi.waitFor(() => expect(started).toHaveLength(1))
    release()
    await opening
    c.onBound('tab-1', 's1')
    c.onBound('tab-1', 's2')
    c.onBound('tab-1', 's2')
    expect(saved.bindings[0]).toMatchObject({ sessionIds: ['s1', 's2'], lastSessionKey: 's2' })
    expect(c.hides('s1') && c.hides('s2') && c.hides('tab-1')).toBe(true)
    expect(c.hides('someone-else')).toBe(false)

    c.onPtyExit('tab-1')
    transcripts.add('s2')
    expect(await c.open(id)).toEqual({ ok: true, tabId: 'tab-resumed-s2' })
    expect(resumed).toEqual(['s2'])
  })

  it('a conductor that never binds before the deadline is closed and reported', async () => {
    vi.useFakeTimers()
    const c = make()
    c.save({ scope: 'global', backend: 'claude', link: LINK })
    const opening = c.open(c.bindings()[0].id)
    await vi.waitFor(() => expect(started).toHaveLength(1))
    release()
    await opening
    vi.advanceTimersByTime(DEADLINE_MS)
    expect(killed).toEqual(['tab-1'])
    expect(toasts).toEqual(['The Global conductor did not start.'])
    expect(c.ownsTab('tab-1')).toBe(false)
  })

  it('removing a workspace unbinds its conductor and closes its tab', async () => {
    const c = make()
    c.save({ scope: '/ws/a', backend: 'claude', link: LINK })
    const opening = c.open(c.bindings()[0].id)
    await vi.waitFor(() => expect(started).toHaveLength(1))
    release()
    await opening
    c.removeWorkspace('/ws/a')
    expect(saved.bindings).toEqual([])
    expect(killed).toEqual(['tab-1'])
  })

  it('a remote workspace’s conductor runs on this Mac, in a folder named by a hash of its key', () => {
    const folder = conductorFolder(userData, 'ssh://devbox/home/me/app')
    expect(path.dirname(folder)).toBe(path.join(userData, 'conductors'))
    expect(path.basename(folder)).toMatch(/^[0-9a-f]{16}$/)
    expect(conductorFolder(userData, '/ws/a')).toBe('/ws/a')
  })
})
