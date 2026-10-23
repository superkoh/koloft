import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  Butler,
  conductorFolder,
  type AssistBackendChoice,
  type ButlerDeps
} from '../../src/main/discord/butler'
import type { BackendId, ButlerSession, DiscordSettings } from '@shared/types'

const CHANNEL = { guildId: '100', channelId: '200', name: 'global' }
const DEADLINE_MS = 1000
const CLAUDE_KEY = 's1'
const CODEX_KEY = 'codex:019a-thread'

let userData: string
let name: string
let formerNames: string[]
let saved: DiscordSettings
let session: ButlerSession
let quiet: DiscordSettings[]
let rescans: number
let started: {
  cwd: string
  role: string
  title: string
  backend: BackendId
  firstPrompt?: string
}[]
let resumed: string[]
let killed: string[]
let toasts: string[]
let transcripts: Set<string>
let choice: AssistBackendChoice
let release: () => void
let testRun = 0

function make(): Butler {
  const run = testRun
  const onlyWhileItsTestRuns =
    <A extends unknown[]>(record: (...args: A) => void) =>
    (...args: A): void => {
      if (run === testRun) record(...args)
    }
  const deps: ButlerDeps = {
    userData,
    butler: () => ({ name, formerNames }),
    load: () => saved,
    loadSession: () => session,
    save: (d) => void (saved = d),
    saveQuietly: (d) => void quiet.push(d),
    saveSession: (s) => void (session = s),
    backend: async () => choice,
    tabAlive: (tabId) => !killed.includes(tabId),
    liveTabFor: () => undefined,
    runningElsewhere: async () => false,
    transcriptExists: async (_backend, key) => transcripts.has(key),
    start: async (l) => {
      started.push({
        cwd: l.cwd,
        role: l.role,
        title: l.title,
        backend: l.backend,
        firstPrompt: l.firstPrompt
      })
      await new Promise<void>((r) => (release = r))
      return `tab-${started.length}`
    },
    resume: async (l) => {
      resumed.push(l.key)
      return `tab-resumed-${l.key}`
    },
    kill: onlyWhileItsTestRuns((tabId: string) => void killed.push(tabId)),
    rowsChanged: () => void rescans++,
    toast: onlyWhileItsTestRuns((t: string) => void toasts.push(t)),
    bindDeadlineMs: DEADLINE_MS
  }
  return new Butler(deps)
}

async function opened(c: Butler): Promise<string> {
  const before = started.length
  const opening = c.open()
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
  formerNames = []
  saved = {}
  session = { sessionIds: [] }
  quiet = []
  rescans = 0
  started = []
  resumed = []
  killed = []
  toasts = []
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
    session = { sessionIds: ['s7'] }
    name = 'Jeeves'
    const c = make()
    for (const ref of ['Jeeves', 'Global-Assist', 'Global-conductor', 's7'])
      expect(c.isButler(ref)).toBe(true)
    expect(c.isButler('Alfred')).toBe(false)
    expect(c.isButler('Global')).toBe(false)
  })

  it('renamed, it still answers to every name it had before, which its sessions were told', () => {
    name = 'Jeeves'
    formerNames = ['Alfred', 'Bunter Two']
    const c = make()
    for (const ref of ['Jeeves', 'Alfred', 'Bunter-Two']) expect(c.isButler(ref)).toBe(true)
    expect(c.isButler('Wooster')).toBe(false)
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
    c.bind(CHANNEL)
    expect(c.identityOfLaunch(conductorFolder(userData), 's1')?.role).toContain(
      'start with [Discord]'
    )
  })

  // ADR-0029
  it('its folder is recognised whether the launch names it through a symlink or by its real path', () => {
    session = { sessionIds: ['s1'] }
    const real = fs.realpathSync(userData)
    const linked = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-link-')), 'userData')
    fs.symlinkSync(real, linked)
    userData = linked
    const c = make()
    fs.mkdirSync(conductorFolder(linked), { recursive: true })
    expect(c.identityOfLaunch(conductorFolder(real), 's1')).toBeDefined()
    expect(c.identityOfLaunch(conductorFolder(linked), 's1')).toBeDefined()
    userData = real
  })

  // ADR-0029
  it('a resume of a recorded butler session in its folder is the butler, so it gets its role back; a fresh launch or another session there is a helper it started, and a workspace Assist’s old folder is no butler at all', () => {
    session = { sessionIds: ['s1', 'codex:local:t1'] }
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
    expect(session).toEqual({ sessionIds: ['s1', 's2'], lastSessionKey: 's2' })
    expect([c.isButlerSession('s1'), c.isButlerSession('s2'), c.isButlerSession(tab)]).toEqual([
      true,
      true,
      true
    ])
    expect(c.isButlerSession('someone-else')).toBe(false)

    c.onPtyExit(tab)
    transcripts.add('s2')
    expect(await c.open()).toEqual({ ok: true, tabId: 'tab-resumed-s2' })
    expect(resumed).toEqual(['s2'])
  })

  // AGY§8
  it('opened with a first prompt, starts a new conversation on it; resumed or already open, it is started on nothing', async () => {
    const c = make()
    const opening = c.open('A helper has it.')
    await vi.waitFor(() => expect(started).toHaveLength(1))
    release()
    expect(await opening).toEqual({ ok: true, tabId: 'tab-1' })
    expect(started[0]).toMatchObject({ firstPrompt: 'A helper has it.' })
    expect(await c.open('again')).toEqual({ ok: true, tabId: 'tab-1' })

    c.onBound('tab-1', 's1')
    c.onPtyExit('tab-1')
    transcripts.add('s1')
    expect(await c.open('again')).toEqual({ ok: true, tabId: 'tab-resumed-s1' })
  })

  it('asked twice while it starts starts once, on the first asker’s prompt', async () => {
    const c = make()
    const a = c.open('first')
    const b = c.open('second')
    await vi.waitFor(() => expect(started).toHaveLength(1))
    release()
    expect(await a).toEqual(await b)
    expect(started).toEqual([expect.objectContaining({ firstPrompt: 'first' })])
  })

  it('a tab resumed some other way and bound to the last session is taken as the butler again', () => {
    session = { sessionIds: ['s1'], lastSessionKey: 's1' }
    const c = make()
    c.onBound('tab-from-the-sidebar', 's1')
    expect(c.isButlerTab('tab-from-the-sidebar')).toBe(true)
    expect(c.liveTab()).toBe('tab-from-the-sidebar')
  })

  it('a fresh conversation forgets which session to resume but still hides the old ones', async () => {
    session = { sessionIds: ['s1'], lastSessionKey: 's1' }
    transcripts.add('s1')
    const c = make()
    const opening = c.startFresh()
    await vi.waitFor(() => expect(started).toHaveLength(1))
    release()
    await opening
    expect(resumed).toEqual([])
    expect(session).toEqual({ sessionIds: ['s1'] })
    expect(c.isButlerSession('s1')).toBe(true)
  })

  it('when its backend changes, the next open starts a new conversation on it and says so once', async () => {
    session = { sessionIds: [CLAUDE_KEY], lastSessionKey: CLAUDE_KEY }
    transcripts.add(CLAUDE_KEY)
    choice = { backend: 'codex' }
    const c = make()
    await opened(c)
    expect(started[0].backend).toBe('codex')
    expect(resumed).toEqual([])
    expect(toasts).toEqual(['Alfred now runs on Codex, so it starts a new conversation.'])
    c.onBound('tab-1', CODEX_KEY)
    expect(session.lastSessionKey).toBe(CODEX_KEY)
  })

  it('when the chosen backend cannot run, it starts on the other one and says why; with neither, nothing starts', async () => {
    choice = { backend: 'codex', because: 'Alfred runs on Codex this time: why.' }
    const c = make()
    await opened(c)
    expect(toasts).toEqual(['Alfred runs on Codex this time: why.'])
    c.onPtyExit('tab-1')
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
    expect(c.isButlerSession('tab-1')).toBe(true)
    c.onPtyExit('tab-1')
    expect(c.isButlerSession('tab-1')).toBe(false)
  })

  it('only while bound to Discord is it kept awake and its channel known by its tab; unbinding keeps its conversation and its tab', async () => {
    const c = make()
    c.bind(CHANNEL)
    const tab = await opened(c)
    c.onBound(tab, 's1')
    expect(c.channelOfTab(tab)).toBe('200')
    expect(c.channelOfTab('another-tab')).toBeUndefined()
    c.unbind()
    expect(saved.channel).toBeUndefined()
    expect(killed).toEqual([])
    expect(c.channelOfTab(tab)).toBeUndefined()
    expect(c.isButlerTab(tab)).toBe(true)
    expect(session.lastSessionKey).toBe('s1')
  })

  it('binding again changes the one channel; the last message read is kept only when it is the same channel', () => {
    saved = { channel: CHANNEL, lastMessageId: '9' }
    const c = make()
    c.bind(CHANNEL)
    expect(saved).toEqual({ channel: CHANNEL, lastMessageId: '9' })
    c.bind({ ...CHANNEL, channelId: '201' })
    expect(saved.channel).toEqual({ ...CHANNEL, channelId: '201' })
    expect(saved.lastMessageId).toBeUndefined()
    expect(c.isButlerChannel('201')).toBe(true)
    expect(c.isButlerChannel('200')).toBe(false)
  })

  it('the last Discord message is saved a second later or at quit, never going back, and without a rescan of the sidebar rows', () => {
    const c = make()
    c.bind(CHANNEL)
    rescans = 0
    vi.useFakeTimers()
    c.setLastMessage('101')
    c.setLastMessage('102')
    c.setLastMessage('100')
    expect(quiet).toHaveLength(0)
    vi.advanceTimersByTime(1000)
    expect(quiet.map((d) => d.lastMessageId)).toEqual(['102'])
    c.setLastMessage('103')
    c.flush()
    expect(quiet.at(-1)?.lastMessageId).toBe('103')
    expect(rescans).toBe(0)
  })

  it('forgets the session ids whose transcript is gone and keeps the rest', () => {
    session = { sessionIds: ['gone-1', 'kept-1'], lastSessionKey: 'gone-1' }
    const c = make()
    const onDisk = new Set(['kept-1'])
    c.forgetGone((key) => onDisk.has(key))
    expect(session).toEqual({ sessionIds: ['kept-1'] })
    expect(c.isButlerSession('gone-1')).toBe(false)
    expect(c.isButlerSession('kept-1')).toBe(true)
    rescans = 0
    c.forgetGone((key) => onDisk.has(key))
    expect(rescans).toBe(0)
  })

  it('while it starts, a session that has no id yet is not taken for the butler’s', async () => {
    const c = make()
    const opening = c.open()
    await vi.waitFor(() => expect(started).toHaveLength(1))
    expect(c.isButlerSession('')).toBe(false)
    release()
    await opening
  })
})
