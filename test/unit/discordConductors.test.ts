import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  Conductors,
  conductorFolder,
  workspaceRemovedLine,
  type AssistBackendChoice,
  type ConductorDeps
} from '../../src/main/discord/conductors'
import type { AssistRecord, BackendId, DiscordSettings } from '@shared/types'

const CHANNEL = { guildId: '100', channelId: '200', name: 'koloft' }
const DEADLINE_MS = 1000
const CLAUDE_KEY = 's1'
const CODEX_KEY = 'codex:019a-thread'

let userData: string
let saved: DiscordSettings
let records: AssistRecord[]
let quiet: DiscordSettings[]
let rescans: number
let started: { cwd: string; role: string; title: string; backend: BackendId }[]
let resumed: string[]
let killed: string[]
let said: { channelId: string; text: string }[]
let toasts: string[]
let taskPushes: number
let transcripts: Set<string>
let choice: AssistBackendChoice
let release: () => void

function make(): Conductors {
  const deps: ConductorDeps = {
    userData,
    load: () => saved,
    loadRecords: () => records,
    save: (d) => void (saved = d),
    saveQuietly: (d) => void quiet.push(d),
    saveRecords: (r) => void (records = r),
    isPinned: (scope) => scope === '/ws/a',
    backend: async () => choice,
    tabAlive: (tabId) => !killed.includes(tabId),
    liveTabFor: () => undefined,
    runningElsewhere: async () => false,
    transcriptExists: async (_backend, key) => transcripts.has(key),
    start: async (l) => {
      started.push({ cwd: l.cwd, role: l.role, title: l.title, backend: l.backend })
      await new Promise<void>((r) => (release = r))
      return `tab-${started.length}`
    },
    resume: async (l) => {
      resumed.push(l.key)
      return `tab-resumed-${l.key}`
    },
    kill: (tabId) => void killed.push(tabId),
    say: (channelId, text) => void said.push({ channelId, text }),
    rowsChanged: () => void rescans++,
    tasksChanged: () => void taskPushes++,
    toast: (t) => void toasts.push(t),
    bindDeadlineMs: DEADLINE_MS
  }
  return new Conductors(deps)
}

async function opened(c: Conductors, scope: string): Promise<string> {
  const before = started.length
  const opening = c.open(scope)
  await vi.waitFor(() => expect(started).toHaveLength(before + 1))
  release()
  const r = await opening
  if (!r.ok) throw new Error(r.error)
  return r.tabId
}

beforeEach(() => {
  userData = fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-conductors-'))
  saved = { bindings: [] }
  records = []
  quiet = []
  rescans = 0
  started = []
  resumed = []
  killed = []
  said = []
  toasts = []
  taskPushes = 0
  transcripts = new Set()
  choice = { backend: 'claude' }
  release = () => {}
})

afterEach(() => {
  vi.useRealTimers()
  fs.rmSync(userData, { recursive: true, force: true })
})

describe('Conductors', () => {
  it('a second open while the first is still starting waits for it and starts nothing new', async () => {
    const c = make()
    const first = c.open('global')
    const second = c.open('global')
    await vi.waitFor(() => expect(started).toHaveLength(1))
    release()
    expect(await first).toEqual({ ok: true, tabId: 'tab-1' })
    expect(await second).toEqual({ ok: true, tabId: 'tab-1' })
    expect(await c.open('global')).toEqual({ ok: true, tabId: 'tab-1' })
    expect(started).toHaveLength(1)
  })

  it('an Assist opens with no Discord binding at all, and a workspace not in the sidebar has none', async () => {
    const c = make()
    expect(await opened(c, '/ws/a')).toBe('tab-1')
    expect(await c.open('/ws/elsewhere')).toEqual({
      ok: false,
      error: 'Pick a workspace from the sidebar, or Global.'
    })
  })

  it('an Assist is found by the name ListAgents shows for it, and by the name it had before it was called Assist', async () => {
    const c = make()
    records = [{ scope: '/ws/a', sessionIds: ['s7'] }]
    const again = make()
    expect(c.scopeOf('Global-Assist')).toBe('global')
    expect(c.scopeOf('Global-conductor')).toBe('global')
    expect(again.scopeOf('a-Assist')).toBe('/ws/a')
    expect(again.scopeOf('a-conductor')).toBe('/ws/a')
    expect(again.scopeOf('s7')).toBe('/ws/a')
    expect(c.scopeOf('Global')).toBeUndefined()
  })

  it('the global Assist starts in its own folder under userData, told its role; on Discord the role says how the owner’s Discord messages reach it', async () => {
    const c = make()
    await opened(c, 'global')
    expect(started[0].cwd).toBe(path.join(userData, 'conductors', 'global'))
    expect(fs.statSync(started[0].cwd).isDirectory()).toBe(true)
    expect(started[0].role).toMatch(/^You are Assist, Koloft's own AI, for all workspaces\./)
    expect(started[0].role).not.toContain('[Discord]')
    c.save({ scope: '/ws/a', channel: CHANNEL }, 'claude')
    await opened(c, '/ws/a')
    expect(started[1].role).toContain('start with [Discord]')
  })

  // ADR-0029
  it('a launch in an Assist folder is that Assist by its folder alone, so any resume or wake gets its role and its gate', async () => {
    records = [{ scope: '/ws/a', sessionIds: [] }]
    const c = make()
    expect(c.identityOfLaunch(conductorFolder(userData, 'global'))?.scope).toBe('global')
    const ws = c.identityOfLaunch(conductorFolder(userData, '/ws/a') + '/')
    expect(ws?.scope).toBe('/ws/a')
    expect(ws?.role).toMatch(/^You are Assist, Koloft's own AI, for the workspace \/ws\/a\./)
    expect(c.identityOfLaunch('/ws/a')).toBeUndefined()
    expect(c.identityOfLaunch(conductorFolder(userData, '/ws/never-had-one'))).toBeUndefined()
  })

  it('every session the Assist binds stays hidden and the newest is the one to resume', async () => {
    const c = make()
    const tab = await opened(c, '/ws/a')
    c.onBound(tab, 's1')
    c.onBound(tab, 's2')
    c.onBound(tab, 's2')
    expect(records).toEqual([{ scope: '/ws/a', sessionIds: ['s1', 's2'], lastSessionKey: 's2' }])
    expect([c.conductorOf('s1'), c.conductorOf('s2'), c.conductorOf(tab)]).toEqual([
      '/ws/a',
      '/ws/a',
      '/ws/a'
    ])
    expect(c.conductorOf('someone-else')).toBeUndefined()

    c.onPtyExit(tab, false)
    transcripts.add('s2')
    expect(await c.open('/ws/a')).toEqual({ ok: true, tabId: 'tab-resumed-s2' })
    expect(resumed).toEqual(['s2'])
  })

  it('a tab resumed some other way and bound to the last session is taken as the Assist again', async () => {
    records = [{ scope: 'global', sessionIds: ['s1'], lastSessionKey: 's1' }]
    const c = make()
    c.onBound('tab-from-the-sidebar', 's1')
    expect(c.scopeOfTab('tab-from-the-sidebar')).toBe('global')
    expect(c.liveTab('global')).toBe('tab-from-the-sidebar')
  })

  it('when the Assist backend changes, the next open starts a new conversation on it and says so once', async () => {
    records = [{ scope: 'global', sessionIds: [CLAUDE_KEY], lastSessionKey: CLAUDE_KEY }]
    transcripts.add(CLAUDE_KEY)
    choice = { backend: 'codex' }
    const c = make()
    await opened(c, 'global')
    expect(started[0].backend).toBe('codex')
    expect(resumed).toEqual([])
    expect(toasts).toEqual([
      'The Global Assist now runs on Codex, so it starts a new conversation.'
    ])
    c.onBound('tab-1', CODEX_KEY)
    expect(records[0].lastSessionKey).toBe(CODEX_KEY)
  })

  it('when the chosen backend cannot run, the Assist starts on the other one and says why; with neither, nothing starts', async () => {
    choice = { backend: 'codex', because: 'Assist runs on Codex this time: why.' }
    const c = make()
    await opened(c, 'global')
    expect(toasts).toEqual(['Assist runs on Codex this time: why.'])
    choice = { error: 'Assist cannot start: no.' }
    expect(await c.open('/ws/a')).toEqual({ ok: false, error: 'Assist cannot start: no.' })
  })

  it('an Assist that never binds before the deadline is closed and reported, and its tab counts as the Assist’s until it is gone', async () => {
    vi.useFakeTimers()
    const c = make()
    const opening = c.open('global')
    await vi.waitFor(() => expect(started).toHaveLength(1))
    release()
    await opening
    vi.advanceTimersByTime(DEADLINE_MS)
    expect(killed).toEqual(['tab-1'])
    expect(toasts).toEqual(['The Global Assist did not start.'])
    expect(c.conductorOf('tab-1')).toBe('global')
    c.onPtyExit('tab-1', false)
    expect(c.conductorOf('tab-1')).toBeUndefined()
  })

  it('only an Assist bound to Discord is kept awake; unbinding keeps its conversation and its tab', async () => {
    const c = make()
    c.save({ scope: '/ws/a', channel: CHANNEL }, 'claude')
    const tab = await opened(c, '/ws/a')
    c.onBound(tab, 's1')
    expect(c.heldResident(tab)).toBe(true)
    c.unbind(c.bindings()[0].id)
    expect(saved.bindings).toEqual([])
    expect(killed).toEqual([])
    expect(c.heldResident(tab)).toBe(false)
    expect(c.scopeOfTab(tab)).toBe('/ws/a')
    expect(records[0].lastSessionKey).toBe('s1')
  })

  it('binding writes the Assist backend onto the binding, and a backend change rewrites every binding, so an older Koloft still reads them all', () => {
    const c = make()
    c.save({ scope: 'global', channel: CHANNEL }, 'claude')
    c.save({ scope: '/ws/a', channel: { ...CHANNEL, channelId: '201' } }, 'claude')
    c.followBackend('codex')
    expect(saved.bindings.map((b) => b.backend)).toEqual(['codex', 'codex'])
  })

  it('a session the Assist touched is saved at once, and the last Discord message a second later or at quit, neither with a rescan of the sidebar rows', async () => {
    const c = make()
    c.save({ scope: 'global', channel: CHANNEL }, 'claude')
    const id = c.bindings()[0].id
    const tab = await opened(c, 'global')
    rescans = 0
    c.touch(tab, 's9')
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

  it('forgets the session ids, touched sessions and threads whose transcript is gone and keeps the rest', () => {
    saved = {
      bindings: [
        {
          id: 'b1',
          scope: 'global',
          backend: 'claude',
          channel: CHANNEL,
          touched: ['kept-2', 'gone-2'],
          threads: [
            { threadId: '7', keys: ['gone-3'] },
            { threadId: '8', keys: ['gone-4', 'kept-3'] }
          ]
        }
      ]
    }
    records = [{ scope: 'global', sessionIds: ['gone-1', 'kept-1'], lastSessionKey: 'gone-1' }]
    const c = make()
    const onDisk = new Set(['kept-1', 'kept-2', 'kept-3'])
    c.forgetGone((key) => onDisk.has(key))
    expect(quiet.at(-1)?.bindings[0]).toMatchObject({
      touched: ['kept-2'],
      threads: [{ threadId: '8', keys: ['kept-3'] }]
    })
    expect(records).toEqual([{ scope: 'global', sessionIds: ['kept-1'] }])
    expect(c.conductorOf('gone-1')).toBeUndefined()
    expect(c.conductorOf('kept-1')).toBe('global')
    c.forgetGone((key) => onDisk.has(key))
    expect(quiet).toHaveLength(1)
  })

  it('a session id is kept by one thread only: keeping it in another moves it there, once, and a thread left with no session goes', () => {
    saved = {
      bindings: [
        {
          id: 'b1',
          scope: 'global',
          backend: 'claude',
          channel: CHANNEL,
          touched: [],
          threads: [{ threadId: '7', keys: ['k1'] }]
        }
      ]
    }
    const c = make()
    c.keepThread('b1', '8', 'k1')
    c.keepThread('b1', '8', 'k1')
    expect(c.bindings()[0].threads).toEqual([{ threadId: '8', keys: ['k1'] }])
    expect(c.threadOfChannel('7')).toBeUndefined()
  })

  it('removing a workspace says so in its channel, then drops its binding and Assist and closes its tab', async () => {
    const c = make()
    c.save({ scope: '/ws/a', channel: CHANNEL }, 'claude')
    const tab = await opened(c, '/ws/a')
    c.onBound(tab, 's1')
    c.removeWorkspace('/ws/a')
    expect(said).toEqual([{ channelId: '200', text: workspaceRemovedLine('/ws/a') }])
    expect(saved.bindings).toEqual([])
    expect(records).toEqual([])
    expect(killed).toEqual([tab])
  })

  it('a task is a second session in the same folder, named after its Assist, told its task, and never the Assist’s everyday conversation', async () => {
    const c = make()
    const opening = c.openTask('global', { name: 'Set up Discord', brief: 'Set up Discord.' })
    await vi.waitFor(() => expect(started).toHaveLength(1))
    release()
    expect(await opening).toEqual({ ok: true, tabId: 'tab-1' })
    expect(started[0].cwd).toBe(conductorFolder(userData, 'global'))
    expect(started[0].title).toBe('Global Assist-Set up Discord')
    expect(started[0].role).toContain('Your task: Set up Discord.')
    expect(started[0].role).toContain('run koloft session close as your very last step')
    expect(c.scopeOfTab('tab-1')).toBe('global')
    expect(c.heldResident('tab-1')).toBe(false)
    expect(c.taskRows()).toEqual([{ tabId: 'tab-1', scope: 'global', name: 'Set up Discord' }])
    c.onBound('tab-1', 'task-key')
    expect(records).toEqual([{ scope: 'global', sessionIds: ['task-key'] }])
    expect(c.identityOfLaunch(conductorFolder(userData, 'global'), 'task-key')?.task).toBe(
      'Set up Discord'
    )
    expect(await c.openTask('global', { name: 'Set up Discord', brief: 'again' })).toEqual({
      ok: true,
      tabId: 'tab-1'
    })
  })

  it('a task that sleeps stays listed and is found again when it wakes in a new tab; closing it ends it', async () => {
    const c = make()
    const opening = c.openTask('global', { name: 'Set up Discord', brief: 'b' })
    await vi.waitFor(() => expect(started).toHaveLength(1))
    release()
    await opening
    c.onBound('tab-1', 'task-key')
    c.onPtyExit('tab-1', true)
    expect(c.taskRows()).toHaveLength(1)
    c.onBound('tab-woken', 'task-key')
    expect(c.taskRows()).toEqual([{ tabId: 'tab-woken', scope: 'global', name: 'Set up Discord' }])
    c.closeTask('tab-woken')
    expect(killed).toEqual(['tab-woken'])
    expect(c.taskRows()).toEqual([])
  })

  it('a task whose session ends on its own leaves the list', async () => {
    const c = make()
    const opening = c.openTask('global', { name: 'Set up Discord', brief: 'b' })
    await vi.waitFor(() => expect(started).toHaveLength(1))
    release()
    await opening
    c.onPtyExit('tab-1', false)
    expect(c.taskRows()).toEqual([])
  })

  // ADR-0029
  it('a workspace’s Assist, local or remote, runs on this Mac in a folder named by a hash of its scope, never in the workspace', () => {
    for (const scope of ['ssh://devbox/home/me/app', '/ws/a']) {
      const folder = conductorFolder(userData, scope)
      expect(path.dirname(folder)).toBe(path.join(userData, 'conductors'))
      expect(path.basename(folder)).toMatch(/^[0-9a-f]{16}$/)
    }
    expect(conductorFolder(userData, '/ws/a')).not.toBe(
      conductorFolder(userData, 'ssh://devbox/home/me/app')
    )
  })

  // ADR-0029
  it('the workspace a local Assist’s koloft commands act on is its workspace, not its folder; the global one has none', async () => {
    const c = make()
    const local = await opened(c, '/ws/a')
    const global = await opened(c, 'global')
    expect(c.workspaceOfTab(local)).toBe('/ws/a')
    expect(c.workspaceOfTab(global)).toBeUndefined()
    expect(c.workspaceOfTab('some-other-tab')).toBeUndefined()
  })
})
