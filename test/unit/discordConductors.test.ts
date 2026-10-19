import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  Conductors,
  conductorFolder,
  type AssistBackendChoice,
  type ConductorDeps
} from '../../src/main/discord/conductors'
import type { AssistRecord, BackendId, DiscordSettings } from '@shared/types'

const CHANNEL = { guildId: '100', channelId: '200', name: 'global' }
const DEADLINE_MS = 1000
const CLAUDE_KEY = 's1'
const CODEX_KEY = 'codex:019a-thread'

let userData: string
let name: string
let saved: DiscordSettings
let records: AssistRecord[]
let quiet: DiscordSettings[]
let rescans: number
let started: { cwd: string; role: string; title: string; backend: BackendId }[]
let resumed: string[]
let killed: string[]
let toasts: string[]
let taskPushes: number
let transcripts: Set<string>
let choice: AssistBackendChoice
let release: () => void
let testRun = 0

function make(): Conductors {
  const run = testRun
  const onlyWhileItsTestRuns =
    <A extends unknown[]>(record: (...args: A) => void) =>
    (...args: A): void => {
      if (run === testRun) record(...args)
    }
  const deps: ConductorDeps = {
    userData,
    name: () => name,
    load: () => saved,
    loadRecords: () => records,
    save: (d) => void (saved = d),
    saveQuietly: (d) => void quiet.push(d),
    saveRecords: (r) => void (records = r),
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
    kill: onlyWhileItsTestRuns((tabId: string) => void killed.push(tabId)),
    rowsChanged: () => void rescans++,
    tasksChanged: onlyWhileItsTestRuns(() => void taskPushes++),
    toast: onlyWhileItsTestRuns((t: string) => void toasts.push(t)),
    bindDeadlineMs: DEADLINE_MS
  }
  return new Conductors(deps)
}

async function opened(c: Conductors): Promise<string> {
  const before = started.length
  const opening = c.open()
  await vi.waitFor(() => expect(started).toHaveLength(before + 1))
  release()
  const r = await opening
  if (!r.ok) throw new Error(r.error)
  return r.tabId
}

async function openedTask(c: Conductors, task: string, words = 'do it'): Promise<string> {
  const before = started.length
  const opening = c.openTask({ name: task, brief: words, ownerWords: words })
  await vi.waitFor(() => expect(started).toHaveLength(before + 1))
  release()
  const r = await opening
  if (!r.ok) throw new Error(r.error)
  return r.tabId
}

beforeEach(() => {
  testRun++
  userData = fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-conductors-'))
  name = 'Alfred'
  saved = { bindings: [] }
  records = []
  quiet = []
  rescans = 0
  started = []
  resumed = []
  killed = []
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

describe('the butler', () => {
  it('a second open while the first is still starting waits for it and starts nothing new', async () => {
    const c = make()
    const first = c.open()
    const second = c.open()
    await vi.waitFor(() => expect(started).toHaveLength(1))
    release()
    expect(await first).toEqual({ ok: true, tabId: 'tab-1' })
    expect(await second).toEqual({ ok: true, tabId: 'tab-1' })
    expect(await c.open()).toEqual({ ok: true, tabId: 'tab-1' })
    expect(started).toHaveLength(1)
  })

  it('is found by its name, by the names the global Assist had, and by any session it bound', () => {
    records = [{ scope: 'global', sessionIds: ['s7'] }]
    name = 'Jeeves'
    const c = make()
    for (const ref of ['Jeeves', 'Global-Assist', 'Global-conductor', 's7'])
      expect(c.isButler(ref)).toBe(true)
    expect(c.isButler('Alfred')).toBe(false)
    expect(c.isButler('Global')).toBe(false)
  })

  it('renamed while it runs, it still answers to the name it started under, which its sessions were told', async () => {
    const c = make()
    await opened(c)
    name = 'Jeeves'
    expect(c.isButler('Alfred')).toBe(true)
    expect(c.isButler('Jeeves')).toBe(true)
  })

  it('starts in the global Assist’s folder under userData, named and told its role by its current name; on Discord the role says how the owner’s Discord messages reach it', async () => {
    name = 'Jeeves'
    const c = make()
    await opened(c)
    expect(started[0].cwd).toBe(path.join(userData, 'conductors', 'global'))
    expect(fs.statSync(started[0].cwd).isDirectory()).toBe(true)
    expect(started[0].title).toBe('Jeeves')
    expect(started[0].role).toMatch(/^Who you are\nYou are Jeeves, the owner's butler in Koloft/)
    expect(started[0].role).not.toContain('[Discord]')
    c.onBound('tab-1', 's1')
    c.bind(CHANNEL, 'claude')
    expect(c.identityOfLaunch(conductorFolder(userData), 's1')?.role).toContain(
      'start with [Discord]'
    )
  })

  // ADR-0029
  it('its folder is recognised whether the launch names it through a symlink or by its real path', () => {
    records = [{ scope: 'global', sessionIds: ['s1'] }]
    const real = fs.realpathSync(userData)
    const linked = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-link-')), 'userData')
    fs.symlinkSync(real, linked)
    userData = linked
    const c = make()
    fs.mkdirSync(conductorFolder(linked), { recursive: true })
    expect(c.identityOfLaunch(conductorFolder(real), 's1')?.scope).toBe('global')
    expect(c.identityOfLaunch(conductorFolder(linked), 's1')?.scope).toBe('global')
    userData = real
  })

  // ADR-0029
  it('a resume of a recorded butler session in its folder is the butler, so it gets its role back; a fresh launch or another session there is a helper it started, and a workspace Assist’s old folder is no butler at all', () => {
    records = [{ scope: 'global', sessionIds: ['s1', 'codex:local:t1'] }]
    const c = make()
    fs.mkdirSync(conductorFolder(userData), { recursive: true })
    expect(c.identityOfLaunch(conductorFolder(userData) + '/', 's1')?.role).toMatch(/^Who you are/)
    expect(c.identityOfLaunch(conductorFolder(userData), 't1')?.role).toMatch(/^Who you are/)
    expect(c.identityOfLaunch(conductorFolder(userData))).toBeUndefined()
    expect(c.identityOfLaunch(conductorFolder(userData), 'helper-1')).toBeUndefined()
    expect(c.identityOfLaunch('/ws/a', 's1')).toBeUndefined()
    const oldWorkspaceAssist = path.join(userData, 'conductors', '0123456789abcdef')
    fs.mkdirSync(oldWorkspaceAssist, { recursive: true })
    expect(c.identityOfLaunch(oldWorkspaceAssist, 's1')).toBeUndefined()
  })

  it('every session it binds stays hidden and the newest is the one to resume', async () => {
    const c = make()
    const tab = await opened(c)
    c.onBound(tab, 's1')
    c.onBound(tab, 's2')
    c.onBound(tab, 's2')
    expect(records).toEqual([{ scope: 'global', sessionIds: ['s1', 's2'], lastSessionKey: 's2' }])
    expect([c.conductorOf('s1'), c.conductorOf('s2'), c.conductorOf(tab)]).toEqual([
      'global',
      'global',
      'global'
    ])
    expect(c.conductorOf('someone-else')).toBeUndefined()

    c.onPtyExit(tab, false)
    transcripts.add('s2')
    expect(await c.open()).toEqual({ ok: true, tabId: 'tab-resumed-s2' })
    expect(resumed).toEqual(['s2'])
  })

  it('a tab resumed some other way and bound to the last session is taken as the butler again', () => {
    records = [{ scope: 'global', sessionIds: ['s1'], lastSessionKey: 's1' }]
    const c = make()
    c.onBound('tab-from-the-sidebar', 's1')
    expect(c.isButlerTab('tab-from-the-sidebar')).toBe(true)
    expect(c.liveTab()).toBe('tab-from-the-sidebar')
  })

  it('when its backend changes, the next open starts a new conversation on it and says so once', async () => {
    records = [{ scope: 'global', sessionIds: [CLAUDE_KEY], lastSessionKey: CLAUDE_KEY }]
    transcripts.add(CLAUDE_KEY)
    choice = { backend: 'codex' }
    const c = make()
    await opened(c)
    expect(started[0].backend).toBe('codex')
    expect(resumed).toEqual([])
    expect(toasts).toEqual(['Alfred now runs on Codex, so it starts a new conversation.'])
    c.onBound('tab-1', CODEX_KEY)
    expect(records[0].lastSessionKey).toBe(CODEX_KEY)
  })

  it('when the chosen backend cannot run, it starts on the other one and says why; with neither, nothing starts', async () => {
    choice = { backend: 'codex', because: 'Alfred runs on Codex this time: why.' }
    const c = make()
    await opened(c)
    expect(toasts).toEqual(['Alfred runs on Codex this time: why.'])
    c.onPtyExit('tab-1', false)
    choice = { error: 'Alfred cannot start: no.' }
    expect(await c.open()).toEqual({ ok: false, error: 'Alfred cannot start: no.' })
  })

  it('one that never binds before the deadline is closed and reported, and its tab counts as the butler’s until it is gone', async () => {
    vi.useFakeTimers()
    const c = make()
    const opening = c.open()
    await vi.waitFor(() => expect(started).toHaveLength(1))
    release()
    await opening
    vi.advanceTimersByTime(DEADLINE_MS)
    expect(killed).toEqual(['tab-1'])
    expect(toasts).toEqual(['Alfred did not start.'])
    expect(c.conductorOf('tab-1')).toBe('global')
    c.onPtyExit('tab-1', false)
    expect(c.conductorOf('tab-1')).toBeUndefined()
  })

  it('only while bound to Discord is it kept awake; unbinding keeps its conversation and its tab', async () => {
    const c = make()
    c.bind(CHANNEL, 'claude')
    const tab = await opened(c)
    c.onBound(tab, 's1')
    expect(c.heldResident(tab)).toBe(true)
    c.unbind()
    expect(saved.bindings).toEqual([])
    expect(killed).toEqual([])
    expect(c.heldResident(tab)).toBe(false)
    expect(c.isButlerTab(tab)).toBe(true)
    expect(records[0].lastSessionKey).toBe('s1')
  })

  it('binding again changes the one channel instead of adding a second, keeping its threads and last message', () => {
    saved = {
      bindings: [
        {
          id: 'b1',
          scope: 'global',
          backend: 'claude',
          channel: CHANNEL,
          touched: [],
          lastMessageId: '9',
          threads: [{ threadId: '7', keys: ['k1'] }]
        }
      ]
    }
    const c = make()
    c.bind({ ...CHANNEL, channelId: '201' }, 'claude')
    expect(saved.bindings).toEqual([
      {
        id: 'b1',
        scope: 'global',
        backend: 'claude',
        channel: { ...CHANNEL, channelId: '201' },
        touched: [],
        lastMessageId: '9',
        threads: [{ threadId: '7', keys: ['k1'] }]
      }
    ])
  })

  it('binding writes its backend onto the binding, and a backend change rewrites it, so an older Koloft still reads it', () => {
    const c = make()
    c.bind(CHANNEL, 'claude')
    c.followBackend('codex')
    expect(saved.bindings.map((b) => b.backend)).toEqual(['codex'])
  })

  it('a session it touched is saved at once, and the last Discord message a second later or at quit, neither with a rescan of the sidebar rows', async () => {
    const c = make()
    c.bind(CHANNEL, 'claude')
    const id = c.bindings()[0].id
    const tab = await opened(c)
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
})

describe('a ⌘P task of the butler', () => {
  it('is a second session in the same folder, named after the butler, told its task, starting from the owner’s words, and never the butler’s everyday conversation', async () => {
    const c = make()
    const tab = await openedTask(c, 'Translate', 'Translate this.')
    expect(tab).toBe('tab-1')
    expect(started[0].cwd).toBe(conductorFolder(userData))
    expect(started[0].title).toBe('Alfred-Translate')
    expect(started[0].role).toContain('Your task: Translate this.')
    expect(started[0].role).toContain('do not close this session')
    expect(c.isButlerTab('tab-1')).toBe(true)
    expect(c.heldResident('tab-1')).toBe(false)
    expect(c.taskRows()).toEqual([{ tabId: 'tab-1', name: 'Translate' }])
    c.onBound('tab-1', 'task-key')
    expect(records).toEqual([{ scope: 'global', sessionIds: ['task-key'] }])
    expect(c.identityOfLaunch(conductorFolder(userData), 'task-key')?.task).toBe('Translate')
    expect(await c.openTask({ name: 'Translate', brief: 'again', ownerWords: 'again' })).toEqual({
      ok: true,
      tabId: 'tab-1'
    })
  })

  it('asked for twice while it starts starts once, and both get its tab', async () => {
    const c = make()
    const task = { name: 'Translate', brief: 'b', ownerWords: 'b' }
    const first = c.openTask(task)
    const second = c.openTask(task)
    await vi.waitFor(() => expect(started).toHaveLength(1))
    release()
    expect(await first).toEqual({ ok: true, tabId: 'tab-1' })
    expect(await second).toEqual({ ok: true, tabId: 'tab-1' })
    expect(c.taskRows()).toHaveLength(1)
  })

  it('that sleeps stays listed and is found again when it wakes in a new tab; closing it ends it', async () => {
    const c = make()
    await openedTask(c, 'Translate')
    c.onBound('tab-1', 'task-key')
    c.onPtyExit('tab-1', true)
    expect(c.taskRows()).toHaveLength(1)
    c.onBound('tab-woken', 'task-key')
    expect(c.taskRows()).toEqual([{ tabId: 'tab-woken', name: 'Translate' }])
    c.closeTask('tab-woken')
    expect(killed).toEqual(['tab-woken'])
    expect(c.taskRows()).toEqual([])
  })

  it('whose session ends on its own leaves the list', async () => {
    const c = make()
    await openedTask(c, 'Translate')
    c.onPtyExit('tab-1', false)
    expect(c.taskRows()).toEqual([])
  })
})
