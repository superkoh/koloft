import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  Butler,
  type AssistBackendChoice,
  type ButlerDeps
} from '../../../../src/plugins/butler/main/butler'
import { conductorFolder, pluginsChangedNews } from '../../../../src/plugins/butler/api'
import type { BackendId, ButlerSession } from '@shared/types'
import type { InstructionsVersion } from '../../../../src/core/ownerInstructions'
import { DISCORD_BOUND } from '../../../../src/plugins/discord/api'
import { realpathSafe } from '../../../../src/main/projectInfo'
import { TODO_NEWS } from '../../../../src/plugins/todo/api'
import { FROM_KOLOFT } from '../../../../src/plugins/sessions/main/crossSessionMessage'

const DEADLINE_MS = 1000
const CLAUDE_KEY = 's1'
const CODEX_KEY = 'codex:019a-thread'

let userData: string
let name: string
let formerNames: string[]
let instructions: InstructionsVersion[] | undefined
let facts: string[]
let session: ButlerSession
let rescans: number
let started: {
  cwd: string
  role: string
  ownerText?: string
  title: string
  backend: BackendId
  firstPrompt?: string
}[]
let resumed: string[]
let killed: string[]
let toasts: string[]
let notices: string[]
let noticeArrives: boolean
let transcripts: Set<string>
let choice: AssistBackendChoice
let release: () => void
let promptShown: Set<string>
let elsewhere: boolean
let resumeGives: string | null | undefined
let testRun = 0
let todoOn: boolean
let passwordsOn: boolean
let noticeLands: Promise<void>
const PLUGIN_NAMES: Record<string, string> = { todo: 'Todo', passwords: 'Passwords and sign-in' }

function make(): Butler {
  const run = testRun
  const onlyWhileItsTestRuns =
    <A extends unknown[]>(record: (...args: A) => void) =>
    (...args: A): void => {
      if (run === testRun) record(...args)
    }
  const deps: ButlerDeps = {
    userData,
    realpath: realpathSafe,
    butler: () => ({ name, formerNames, instructions }),
    roleFacts: () => facts,
    loadSession: () => session,
    saveSession: (s) => void (session = s),
    backend: async () => choice,
    tabAlive: (tabId) => !killed.includes(tabId),
    liveTabFor: () => undefined,
    runningElsewhere: async () => elsewhere,
    transcriptExists: async (_backend, key) => transcripts.has(key),
    start: async (l) => {
      started.push({
        cwd: l.cwd,
        role: l.role,
        ownerText: l.ownerText,
        title: l.title,
        backend: l.backend,
        firstPrompt: l.firstPrompt
      })
      await new Promise<void>((r) => (release = r))
      return `tab-${started.length}`
    },
    resume: async (l) => {
      resumed.push(l.key)
      return resumeGives === undefined ? `tab-resumed-${l.key}` : resumeGives
    },
    kill: onlyWhileItsTestRuns((tabId: string) => void killed.push(tabId)),
    rowsChanged: () => void rescans++,
    toast: onlyWhileItsTestRuns((t: string) => void toasts.push(t)),
    notice: async (t) => {
      if (run === testRun) notices.push(t)
      return noticeArrives
    },
    noticeWhileOpen: async (t) => {
      if (!butler.liveTab()) return false
      if (run === testRun) notices.push(t)
      await noticeLands
      return noticeArrives && !!butler.liveTab()
    },
    news: { ...TODO_NEWS, on: () => todoOn },
    pluginsOn: () => ({ todo: todoOn, passwords: passwordsOn }),
    pluginsNews: (changed) =>
      pluginsChangedNews(
        Object.entries(changed).map(([id, on]) => ({ name: PLUGIN_NAMES[id], on }))
      ),
    showsPromptBeforeBind: (tabId) => promptShown.has(tabId),
    bindDeadlineMs: DEADLINE_MS
  }
  const butler = new Butler(deps)
  return butler
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
  todoOn = true
  passwordsOn = true
  noticeLands = Promise.resolve()
  userData = fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-conductors-'))
  name = 'Alfred'
  formerNames = []
  instructions = undefined
  facts = []
  session = { sessionIds: [] }
  rescans = 0
  started = []
  resumed = []
  killed = []
  toasts = []
  notices = []
  noticeArrives = true
  transcripts = new Set()
  choice = { backend: 'claude' }
  release = () => {}
  promptShown = new Set()
  elsewhere = false
  resumeGives = undefined
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
    facts = [DISCORD_BOUND]
    expect(c.identityOfLaunch(conductorFolder(userData), 's1')?.role).toContain(
      'start with [Discord]'
    )
  })

  it('the owner’s instructions go beside its role, both when it starts and when Codex, Muse or Antigravity resume it; with none written, nothing is added', async () => {
    instructions = [
      { text: 'Old words.', at: 1, by: 'owner' },
      { text: 'Answer in Chinese.', at: 2, by: 'owner' }
    ]
    const others = ['codex:local:t1', 'muse:local:t2', 'agy:local:t3']
    session = { sessionIds: others }
    const c = make()
    await opened(c)
    expect(started[0].role).toMatch(/^Who you are/)
    expect(started[0].role).not.toContain('Answer in Chinese.')
    expect(started[0].ownerText).toBe('Written by the owner\nAnswer in Chinese.')
    for (const key of others)
      expect(c.identityOfLaunch(conductorFolder(userData), key)).toEqual({
        role: started[0].role,
        ownerText: 'Written by the owner\nAnswer in Chinese.'
      })
    instructions = [...instructions, { text: '', at: 3, by: 'owner' }]
    expect(c.identityOfLaunch(conductorFolder(userData), 'codex:local:t1')).toEqual({
      role: started[0].role
    })
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
    expect(session).toEqual({
      sessionIds: ['s1', 's2'],
      lastSessionKey: 's2',
      pluginsSeen: { key: 's2', on: { todo: true, passwords: true } },
      knowsTodo: ['s1', 's2']
    })
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

  // CC§23 CODEX§17 MUSE§9 AGY§8
  it('a conversation from before koloft todo, which keeps the role it started with, is told of it when resumed until the notice gets through, then never again, on Claude too; one started since is told nothing', async () => {
    const OLD_CODEX = 'codex:local:old-thread'
    const NEW_CODEX = 'codex:local:new-thread'
    const tab = `tab-resumed-${OLD_CODEX}`
    session = { sessionIds: [OLD_CODEX], lastSessionKey: OLD_CODEX }
    transcripts.add(OLD_CODEX)
    choice = { backend: 'codex' }
    noticeArrives = false
    const c = make()
    expect(await c.open()).toEqual({ ok: true, tabId: tab })
    expect(notices).toEqual([
      '(From Koloft:) Koloft got a new command after this conversation began: koloft todo. When the owner asks you to sort out the to-dos, or what waits on them, run koloft todo and do what it prints. There is nothing to answer now.'
    ])
    c.onPtyExit(tab)
    noticeArrives = true
    await c.open()
    expect(notices).toHaveLength(2)
    await vi.waitFor(() => expect(session.knowsTodo).toEqual([OLD_CODEX]))
    c.onBound(tab, OLD_CODEX)
    c.onPtyExit(tab)
    await c.open()
    expect(notices).toHaveLength(2)

    session = { sessionIds: [CLAUDE_KEY], lastSessionKey: CLAUDE_KEY }
    transcripts.add(CLAUDE_KEY)
    choice = { backend: 'claude' }
    await make().open()
    expect(notices).toHaveLength(3)
    await vi.waitFor(() => expect(session.knowsTodo).toContain(CLAUDE_KEY))

    session = { sessionIds: [] }
    choice = { backend: 'codex' }
    const fresh = make()
    const freshTab = await opened(fresh)
    fresh.onBound(freshTab, NEW_CODEX)
    fresh.onPtyExit(freshTab)
    transcripts.add(NEW_CODEX)
    await fresh.open()
    expect(notices).toHaveLength(3)
  })

  it('while Todo is off, a resumed conversation is told nothing of koloft todo and one started then is not counted as knowing it, so it is told once Todo is on again', async () => {
    const OLD_CODEX = 'codex:local:old-thread'
    const NEW_CODEX = 'codex:local:new-thread'
    todoOn = false
    session = { sessionIds: [OLD_CODEX], lastSessionKey: OLD_CODEX }
    transcripts.add(OLD_CODEX)
    choice = { backend: 'codex' }
    const c = make()
    const tab = `tab-resumed-${OLD_CODEX}`
    expect(await c.open()).toEqual({ ok: true, tabId: tab })
    expect(notices).toEqual([])
    expect(session.knowsTodo).toBeUndefined()
    c.onPtyExit(tab)

    session = { sessionIds: [] }
    const fresh = make()
    const freshTab = await opened(fresh)
    fresh.onBound(freshTab, NEW_CODEX)
    expect(session.knowsTodo).toBeUndefined()
    fresh.onPtyExit(freshTab)

    todoOn = true
    transcripts.add(NEW_CODEX)
    await fresh.open()
    expect(notices).toEqual([
      `${FROM_KOLOFT}${TODO_NEWS.text} The owner changed Settings ▸ Plugins after this conversation began: Todo is now on. A plugin that is off takes away its commands and what your instructions say about it; run koloft help to see what you can use now. There is nothing to answer now.`
    ])
  })

  it('what it is told when the owner changed plugins since its conversation began, pinned', () =>
    expect(
      pluginsChangedNews([
        { name: 'Todo', on: false },
        { name: 'Passwords and sign-in', on: true }
      ])
    ).toMatchFileSnapshot('../../prompt-text/butler/plugins-changed.txt'))

  // CC§23 CODEX§17 MUSE§9 AGY§8
  it('running, it is told at once in one message every plugin a switch change turned on or off, and nothing when its conversation already knows; not running, it is not started for it, and is told when its conversation is resumed', async () => {
    const c = make()
    const tab = await opened(c)
    c.onBound(tab, CLAUDE_KEY)
    c.pluginsSwitched()
    todoOn = false
    passwordsOn = false
    c.pluginsSwitched()
    await vi.waitFor(() =>
      expect(session.pluginsSeen).toEqual({
        key: CLAUDE_KEY,
        on: { todo: false, passwords: false }
      })
    )
    expect(notices).toEqual([
      `${FROM_KOLOFT}The owner changed Settings ▸ Plugins after this conversation began: Todo is now off, Passwords and sign-in is now off. A plugin that is off takes away its commands and what your instructions say about it; run koloft help to see what you can use now. There is nothing to answer now.`
    ])
    c.pluginsSwitched()
    expect(notices).toHaveLength(1)

    c.onPtyExit(tab)
    todoOn = true
    c.pluginsSwitched()
    expect(notices).toHaveLength(1)
    expect(started).toHaveLength(1)
    transcripts.add(CLAUDE_KEY)
    expect(await c.open()).toEqual({ ok: true, tabId: `tab-resumed-${CLAUDE_KEY}` })
    expect(notices).toHaveLength(2)
    expect(notices[1]).toContain('after this conversation began: Todo is now on. ')
  })

  it('a switch flipped while a new conversation is still starting is told once it binds, measured against what it was started with', async () => {
    const c = make()
    const opening = c.open()
    await vi.waitFor(() => expect(started).toHaveLength(1))
    todoOn = false
    c.pluginsSwitched()
    release()
    const opened = await opening
    if (!opened.ok) throw new Error(opened.error)
    c.pluginsSwitched()
    expect(notices).toEqual([])
    c.onBound(opened.tabId, CLAUDE_KEY)
    await vi.waitFor(() => expect(notices).toHaveLength(1))
    expect(notices[0]).toContain(': Todo is now off. ')
  })

  it('a message that does not get through, because the butler closed or the hand-over failed, is told again at its next resume', async () => {
    const c = make()
    const tab = await opened(c)
    c.onBound(tab, CLAUDE_KEY)
    let land = (): void => {}
    noticeLands = new Promise((resolve) => (land = resolve))
    noticeArrives = false
    todoOn = false
    c.pluginsSwitched()
    c.pluginsSwitched()
    expect(notices).toHaveLength(1)
    land()
    await vi.waitFor(() =>
      expect(session.pluginsSeen).toEqual({ key: CLAUDE_KEY, on: { todo: true, passwords: true } })
    )

    c.onPtyExit(tab)
    noticeLands = Promise.resolve()
    noticeArrives = true
    transcripts.add(CLAUDE_KEY)
    await c.open()
    expect(notices).toHaveLength(2)
    expect(notices[1]).toContain(': Todo is now off. ')
  })

  it('two messages on their way at once that both fail leave both changes to tell at the next resume', async () => {
    const c = make()
    const tab = await opened(c)
    c.onBound(tab, CLAUDE_KEY)
    let land = (): void => {}
    noticeLands = new Promise((resolve) => (land = resolve))
    noticeArrives = false
    todoOn = false
    c.pluginsSwitched()
    passwordsOn = false
    c.pluginsSwitched()
    expect(notices).toHaveLength(2)
    expect(notices[1]).toContain(': Passwords and sign-in is now off. ')
    land()
    await vi.waitFor(() =>
      expect(session.pluginsSeen).toEqual({ key: CLAUDE_KEY, on: { todo: true, passwords: true } })
    )

    c.onPtyExit(tab)
    noticeLands = Promise.resolve()
    noticeArrives = true
    transcripts.add(CLAUDE_KEY)
    await c.open()
    expect(notices[2]).toContain(': Todo is now off, Passwords and sign-in is now off. ')
  })

  it('a conversation from before Koloft kept what it knows of the plugins is told nothing of a switch at its first resume, only of later ones', async () => {
    session = { sessionIds: [CLAUDE_KEY], lastSessionKey: CLAUDE_KEY, knowsTodo: [CLAUDE_KEY] }
    transcripts.add(CLAUDE_KEY)
    passwordsOn = false
    const c = make()
    const tab = `tab-resumed-${CLAUDE_KEY}`
    expect(await c.open()).toEqual({ ok: true, tabId: tab })
    expect(notices).toEqual([])
    c.onBound(tab, CLAUDE_KEY)
    passwordsOn = true
    c.pluginsSwitched()
    await vi.waitFor(() => expect(notices).toHaveLength(1))
    expect(notices[0]).toContain(': Passwords and sign-in is now on. ')
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

  // CC§3 CODEX§11
  it('given a model and thinking, it resumes its conversation with them and remembers them; set back to the tool’s own, it starts a new conversation and says so, since the old one would keep what it was given', async () => {
    session = { sessionIds: [CLAUDE_KEY], lastSessionKey: CLAUDE_KEY }
    transcripts.add(CLAUDE_KEY)
    choice = { backend: 'claude', model: 'opus', effort: 'high' }
    expect((await make().open()).ok).toBe(true)
    expect(resumed).toEqual([CLAUDE_KEY])
    expect(session.carried).toEqual({ model: 'opus', effort: 'high' })
    expect(toasts).toEqual([])

    choice = { backend: 'claude', model: 'opus' }
    await opened(make())
    expect(resumed).toEqual([CLAUDE_KEY])
    expect(toasts).toEqual([
      'Alfred goes back to Claude’s own model or thinking, so it starts a new conversation.'
    ])
    expect(session.carried).toEqual({ model: 'opus' })
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

  it('refuses to open while its conversation runs in another process, and says so when its tab never comes', async () => {
    session = { sessionIds: [CLAUDE_KEY], lastSessionKey: CLAUDE_KEY }
    elsewhere = true
    expect(await make().open()).toEqual({
      ok: false,
      error: 'Alfred is already running in another claude process.'
    })
    elsewhere = false
    transcripts.add(CLAUDE_KEY)
    resumeGives = null
    expect(await make().open()).toEqual({ ok: false, error: 'Alfred could not start.' })
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

  // AGY§8
  it('on Antigravity, which makes its conversation only at the first prompt, one started with nothing to say that sits at its prompt at the deadline is kept, and held to the deadline again once words are on their way', async () => {
    vi.useFakeTimers()
    choice = { backend: 'agy' }
    const c = make()
    const tab = await opened(c)
    promptShown.add(tab)
    vi.advanceTimersByTime(DEADLINE_MS)
    expect(killed).toEqual([])
    expect(toasts).toEqual([])
    expect(c.firstWordsComing(tab)).toBe(true)
    expect(c.firstWordsComing(tab)).toBe(false)
    promptShown.delete(tab)
    vi.advanceTimersByTime(DEADLINE_MS)
    expect(killed).toEqual([tab])
    expect(toasts).toEqual(['Alfred did not start.'])
  })

  // AGY§5 AGY§8
  it('on Antigravity, one stuck on a setup screen at launch is closed at the deadline as not started, with no words sent', async () => {
    vi.useFakeTimers()
    choice = { backend: 'agy' }
    const c = make()
    const tab = await opened(c)
    vi.advanceTimersByTime(DEADLINE_MS)
    expect(killed).toEqual([tab])
    expect(toasts).toEqual(['Alfred did not start.'])
  })

  // AGY§8
  it('on Antigravity, words asked to open an already open quiet butler are handed to it once as a notice, however many ask; one started on words or resumed waits for none', async () => {
    choice = { backend: 'agy' }
    const c = make()
    const quiet = await opened(c)
    await Promise.all([c.open('a helper has it'), c.open('a helper has it')])
    expect(notices).toEqual(['a helper has it'])
    c.onPtyExit(quiet)

    const told = c.open('set up Discord')
    await vi.waitFor(() => expect(started).toHaveLength(2))
    release()
    const toldTab = await told
    if (!toldTab.ok) throw new Error(toldTab.error)
    expect(started[1].firstPrompt).toBe('set up Discord')
    expect(c.firstWordsComing(toldTab.tabId)).toBe(false)
    c.onPtyExit(toldTab.tabId)

    const agyKey = 'agy:local:conv-1'
    session = { sessionIds: [agyKey], lastSessionKey: agyKey, knowsTodo: [agyKey] }
    transcripts.add(agyKey)
    const again = make()
    const resumedTab = await again.open('a helper has it')
    if (!resumedTab.ok) throw new Error(resumedTab.error)
    expect(again.firstWordsComing(resumedTab.tabId)).toBe(false)
    expect(notices).toHaveLength(1)
  })

  it('a quiet Antigravity butler that bound already waits for no first words', async () => {
    vi.useFakeTimers()
    choice = { backend: 'agy' }
    const c = make()
    const tab = await opened(c)
    c.onBound(tab, 'agy:local:conv-1')
    expect(c.firstWordsComing(tab)).toBe(false)
    vi.advanceTimersByTime(DEADLINE_MS)
    expect(killed).toEqual([])
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
