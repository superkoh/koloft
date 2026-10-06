import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { Conductors, conductorFolder, type ConductorDeps } from '../../src/main/discord/conductors'
import type { DiscordSettings } from '@shared/types'

const CHANNEL = { guildId: '100', channelId: '200', name: 'koloft' }
const DEADLINE_MS = 1000

let userData: string
let saved: DiscordSettings
let quiet: DiscordSettings[]
let rescans: number
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
    saveQuietly: (d) => void quiet.push(d),
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
    rowsChanged: () => void rescans++,
    toast: (t) => void toasts.push(t),
    bindDeadlineMs: DEADLINE_MS
  }
  return new Conductors(deps)
}

beforeEach(() => {
  userData = fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-conductors-'))
  saved = { bindings: [] }
  quiet = []
  rescans = 0
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
    expect(c.save({ scope: 'global', backend: 'claude', channel: CHANNEL })).toEqual({ ok: true })
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
    c.save({ scope: 'global', backend: 'claude', channel: CHANNEL })
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
    c.save({ scope: '/ws/a', backend: 'claude', channel: CHANNEL })
    const id = c.bindings()[0].id
    const opening = c.open(id)
    await vi.waitFor(() => expect(started).toHaveLength(1))
    release()
    await opening
    c.onBound('tab-1', 's1')
    c.onBound('tab-1', 's2')
    c.onBound('tab-1', 's2')
    expect(saved.bindings[0]).toMatchObject({ sessionIds: ['s1', 's2'], lastSessionKey: 's2' })
    expect([c.conductorOf('s1'), c.conductorOf('s2'), c.conductorOf('tab-1')]).toEqual([id, id, id])
    expect(c.conductorOf('someone-else')).toBeUndefined()

    c.onPtyExit('tab-1')
    transcripts.add('s2')
    expect(await c.open(id)).toEqual({ ok: true, tabId: 'tab-resumed-s2' })
    expect(resumed).toEqual(['s2'])
  })

  it('a conductor that never binds before the deadline is closed and reported, and its tab counts as the conductor’s until it is gone, so its closing is no session notice', async () => {
    vi.useFakeTimers()
    const c = make()
    c.save({ scope: 'global', backend: 'claude', channel: CHANNEL })
    const id = c.bindings()[0].id
    const opening = c.open(id)
    await vi.waitFor(() => expect(started).toHaveLength(1))
    release()
    await opening
    vi.advanceTimersByTime(DEADLINE_MS)
    expect(killed).toEqual(['tab-1'])
    expect(toasts).toEqual(['The Global conductor did not start.'])
    expect(c.conductorOf('tab-1')).toBe(id)
    c.onPtyExit('tab-1')
    expect(c.conductorOf('tab-1')).toBeUndefined()
  })

  it('a session the conductor touched is saved at once, and the last Discord message a second later or at quit, neither with a rescan of the sidebar rows', async () => {
    const c = make()
    c.save({ scope: 'global', backend: 'claude', channel: CHANNEL })
    const id = c.bindings()[0].id
    const opening = c.open(id)
    await vi.waitFor(() => expect(started).toHaveLength(1))
    release()
    await opening
    rescans = 0
    c.touch('tab-1', 's9')
    expect(quiet.at(-1)?.bindings[0].touched).toEqual(['s9'])

    vi.useFakeTimers()
    c.setLastMessage(id, '101')
    c.setLastMessage(id, '102')
    expect(quiet).toHaveLength(1)
    vi.advanceTimersByTime(1000)
    expect(quiet.map((d) => d.bindings[0].lastMessageId)).toEqual([undefined, '102'])
    c.setLastMessage(id, '103')
    c.flush()
    expect(quiet.at(-1)?.bindings[0].lastMessageId).toBe('103')
    expect(rescans).toBe(0)
  })

  it('forgets the session ids, touched sessions and threads whose transcript is gone, keeps the rest, and saves only when something went, without a rescan of the sidebar rows', () => {
    saved = {
      bindings: [
        {
          id: 'b1',
          scope: 'global',
          backend: 'claude',
          channel: CHANNEL,
          sessionIds: ['gone-1', 'kept-1'],
          lastSessionKey: 'gone-1',
          touched: ['kept-2', 'gone-2'],
          threads: [
            { threadId: '7', keys: ['gone-3'] },
            { threadId: '8', keys: ['gone-4', 'kept-3'] }
          ]
        }
      ]
    }
    const c = make()
    const onDisk = new Set(['kept-1', 'kept-2', 'kept-3'])
    c.forgetGone((key) => onDisk.has(key))
    expect(quiet.at(-1)?.bindings[0]).toMatchObject({
      sessionIds: ['kept-1'],
      lastSessionKey: 'gone-1',
      touched: ['kept-2'],
      threads: [{ threadId: '8', keys: ['kept-3'] }]
    })
    expect(c.conductorOf('gone-1')).toBeUndefined()
    expect(c.conductorOf('kept-1')).toBe('b1')
    c.forgetGone((key) => onDisk.has(key))
    expect(quiet).toHaveLength(1)
    expect(rescans).toBe(0)
  })

  it('removing a workspace unbinds its conductor and closes its tab', async () => {
    const c = make()
    c.save({ scope: '/ws/a', backend: 'claude', channel: CHANNEL })
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
