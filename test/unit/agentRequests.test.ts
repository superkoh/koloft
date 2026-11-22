import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

vi.mock('node-pty', () => ({ spawn: vi.fn() }))

import { agentGuide } from '../../src/shared/agentGuide'
import {
  AGENT_TOOLS_OFF,
  AgentRequests,
  NOT_ITS_PASS,
  type AgentRequestDeps,
  type TabFacts
} from '../../src/main/agentRequests'
import { passOf } from '../../src/main/tabPass'
import { answered, type AgentCaller } from '../../src/core/command'
import { helpVerb } from '../../src/plugins/sessions/main/sessionVerbs'
import type { SessionInfo } from '../../src/shared/types'
import { testCommands } from './helpers/testCommands'

const OTHER_LIVE_INSTANCE = process.pid + 1
const tabOf = (pid: number, n: number): string => `pty-${pid.toString(36)}-${n}`
const from = (tabId: string): { tabId: string; pass: string } => ({ tabId, pass: passOf(tabId) })

let dir: string
let calls: { args: string[]; caller: AgentCaller }[]
let tabs: Map<string, TabFacts>
let on: boolean
let rulesOf: Map<string, string>

function requests(extra: Partial<AgentRequestDeps> = {}): AgentRequests {
  return new AgentRequests({
    commands: testCommands({
      help: helpVerb(async (tabId) => rulesOf.get(tabId)),
      echo: (args, caller) => {
        calls.push({ args, caller })
        return answered(args.join(' '))
      },
      boom: () => {
        throw new Error('the disk is full')
      }
    }),
    tab: (id) => tabs.get(id),
    session: (id) => sessionOf(id),
    enabled: () => on,
    alive: (pid) => pid === OTHER_LIVE_INSTANCE,
    ...extra
  })
}

function sessionOf(tabId: string): SessionInfo {
  return {
    tabId,
    backendId: 'claude',
    host: 'local',
    sessionId: `${tabId}-session`,
    title: 'Fix login',
    cwd: '/w',
    treeRoot: '/w',
    alive: true,
    updatedAt: 1
  }
}

function drop(name: string, body: unknown): void {
  fs.writeFileSync(path.join(dir, name), JSON.stringify(body))
}

function reply(id: string): unknown {
  const file = path.join(dir, `res-${id}.json`)
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-agent-req-'))
  calls = []
  tabs = new Map([[tabOf(process.pid, 1), { util: false }]])
  on = true
  rulesOf = new Map()
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('koloft requests from a session', () => {
  it('help, or no command at all, answers with the guide', async () => {
    const r = requests()
    const tabId = tabOf(process.pid, 1)
    await r.answer(dir, 'req-a.json', { ...from(tabId), argv: ['help'], cwd: '/w' })
    await r.answer(dir, 'req-b.json', { ...from(tabId), argv: [], cwd: '/w' })
    expect(reply('a')).toEqual({ exit: 0, text: agentGuide() })
    expect(reply('b')).toEqual({ exit: 0, text: agentGuide() })
  })

  it('help in a session of a workspace with its own rules for picking a model answers with the guide that carries them, --help too', async () => {
    const r = requests()
    const tabId = tabOf(process.pid, 1)
    rulesOf.set(tabId, 'Code: opus, high.')
    await r.answer(dir, 'req-a.json', { ...from(tabId), argv: ['help'], cwd: '/w' })
    await r.answer(dir, 'req-b.json', { ...from(tabId), argv: ['--help'], cwd: '/w' })
    expect(reply('a')).toEqual({ exit: 0, text: agentGuide('Code: opus, high.') })
    expect(reply('b')).toEqual({ exit: 0, text: agentGuide('Code: opus, high.') })
  })

  it('a --help among the words answers with the guide and runs nothing, so it is never taken as an answer or a message; after -- it is a word', async () => {
    const r = requests()
    const tabId = tabOf(process.pid, 1)
    await r.answer(dir, 'req-a.json', {
      ...from(tabId),
      argv: ['echo', 'fix-login', '--help'],
      cwd: '/w'
    })
    await r.answer(dir, 'req-b.json', { ...from(tabId), argv: ['--help'], cwd: '/w' })
    expect(reply('a')).toEqual({ exit: 0, text: agentGuide() })
    expect(reply('b')).toEqual({ exit: 0, text: agentGuide() })
    expect(calls).toEqual([])
    await r.answer(dir, 'req-c.json', {
      ...from(tabId),
      argv: ['echo', 'a', '--', '--help'],
      cwd: '/w'
    })
    expect(reply('c')).toEqual({ exit: 0, text: 'a -- --help' })
  })

  it('an unknown command is refused with exit code 2 and points at koloft help', async () => {
    const tabId = tabOf(process.pid, 1)
    await requests().answer(dir, 'req-a.json', {
      ...from(tabId),
      argv: ['frobnicate', 'x'],
      cwd: '/w'
    })
    await requests().answer(dir, 'req-b.json', { ...from(tabId), argv: ['constructor'], cwd: '/w' })
    expect(reply('a')).toEqual({
      exit: 2,
      text: 'koloft: there is no "frobnicate" command. Run "koloft help" to see the commands.'
    })
    expect(reply('b')).toEqual({
      exit: 2,
      text: 'koloft: there is no "constructor" command. Run "koloft help" to see the commands.'
    })
  })

  it('a command that throws is answered with koloft: and the error, exit code 1', async () => {
    const tabId = tabOf(process.pid, 1)
    await requests().answer(dir, 'req-a.json', { ...from(tabId), argv: ['boom'], cwd: '/w' })
    expect(reply('a')).toEqual({ exit: 1, text: 'koloft: the disk is full' })
  })

  it('hands the command its words after the verb and the session tab it came from', async () => {
    const tabId = tabOf(process.pid, 1)
    await requests().answer(dir, 'req-a.json', {
      ...from(tabId),
      argv: ['echo', 'a b', 'c'],
      cwd: '/w'
    })
    expect(calls).toEqual([
      { args: ['a b', 'c'], caller: { tabId, cwd: '/w', session: sessionOf(tabId) } }
    ])
    expect(reply('a')).toEqual({ exit: 0, text: 'a b c' })
  })

  it('a request typed in a Workbench shell acts for the session tab that shell belongs to', async () => {
    const owner = tabOf(process.pid, 1)
    const shell = tabOf(process.pid, 2)
    tabs.set(shell, { util: true, ownerTabId: owner })
    await requests().answer(dir, 'req-a.json', { ...from(shell), argv: ['echo'], cwd: '/w' })
    expect(calls.map((c) => c.caller.tabId)).toEqual([owner])
  })

  it('a request that names another tab without that tab’s KOLOFT_TAB_PASS is refused and runs nothing: no pass, its own pass, or a made-up one', async () => {
    const butler = tabOf(process.pid, 1)
    const other = tabOf(process.pid, 2)
    tabs.set(other, { util: false })
    const r = requests()
    await r.answer(dir, 'req-a.json', { tabId: butler, argv: ['echo'], cwd: '/w' })
    await r.answer(dir, 'req-b.json', {
      tabId: butler,
      pass: passOf(other),
      argv: ['echo'],
      cwd: '/w'
    })
    await r.answer(dir, 'req-c.json', {
      tabId: butler,
      pass: 'f'.repeat(64),
      argv: ['echo'],
      cwd: '/w'
    })
    for (const id of ['a', 'b', 'c']) expect(reply(id)).toEqual({ exit: 1, text: NOT_ITS_PASS })
    expect(calls).toEqual([])
  })

  it("leaves another running Koloft's request untouched, though its pass is not one this Koloft gave, and answers one whose Koloft is gone", async () => {
    const theirs = tabOf(OTHER_LIVE_INSTANCE, 1)
    drop('req-a.json', { tabId: theirs, argv: ['echo'], cwd: '/w' })
    await requests().answer(dir, 'req-a.json', { tabId: theirs, argv: ['echo'], cwd: '/w' })
    expect(fs.existsSync(path.join(dir, 'req-a.json'))).toBe(true)
    expect(reply('a')).toBeNull()

    const orphan = tabOf(process.pid + 2, 1)
    await requests().answer(dir, 'req-b.json', { tabId: orphan, argv: ['echo'], cwd: '/w' })
    expect(reply('b')).toEqual({ exit: 1, text: expect.any(String) })
    expect(calls).toEqual([])
  })

  it('refuses every command while agent tools are off', async () => {
    on = false
    const tabId = tabOf(process.pid, 1)
    await requests().answer(dir, 'req-a.json', { ...from(tabId), argv: ['echo'], cwd: '/w' })
    expect(reply('a')).toEqual({ exit: 1, text: AGENT_TOOLS_OFF })
    expect(calls).toEqual([])
  })

  it('a tab Koloft holds no session for is refused, and nothing runs', async () => {
    const tabId = tabOf(process.pid, 1)
    const r = requests({ session: () => undefined })
    await r.answer(dir, 'req-a.json', { ...from(tabId), argv: ['echo'], cwd: '/w' })
    expect(reply('a')).toEqual({ exit: 1, text: expect.any(String) })
    expect(calls).toEqual([])
  })

  it('runs a request delivered twice only once, so a command never takes effect twice', async () => {
    const r = requests()
    const body = { ...from(tabOf(process.pid, 1)), argv: ['echo'], cwd: '/w' }
    await Promise.all([r.answer(dir, 'req-a.json', body), r.answer(dir, 'req-a.json', body)])
    expect(calls).toHaveLength(1)
  })

  it('a Codex request carries no tab id: it is answered for the tab its folder belongs to', async () => {
    const tabId = tabOf(process.pid, 1)
    const pass = passOf(tabId)
    await requests().answerFor(tabId, dir, 'req-a.json', { pass, argv: ['echo'], cwd: '/w' })
    await requests().answerFor(undefined, dir, 'req-b.json', { pass, argv: ['echo'], cwd: '/w' })
    expect(calls.map((c) => c.caller.tabId)).toEqual([tabId])
    expect(reply('b')).toEqual({ exit: 1, text: expect.any(String) })
  })

  it('a request dropped into another tab’s folder, with no pass or the dropping tab’s own, is refused and runs nothing', async () => {
    const folderTab = tabOf(process.pid, 1)
    const dropper = tabOf(process.pid, 2)
    await requests().answerFor(folderTab, dir, 'req-a.json', { argv: ['echo'], cwd: '/w' })
    await requests().answerFor(folderTab, dir, 'req-b.json', {
      pass: passOf(dropper),
      argv: ['echo'],
      cwd: '/w'
    })
    expect(reply('a')).toEqual({ exit: 1, text: NOT_ITS_PASS })
    expect(reply('b')).toEqual({ exit: 1, text: NOT_ITS_PASS })
    expect(calls).toEqual([])
  })

  // PLATFORM§28
  it('answers, once, a request its folder watch never reported', async () => {
    drop('req-a.json', { ...from(tabOf(process.pid, 1)), argv: ['echo', 'late'], cwd: '/w' })
    await new Promise((r) => setTimeout(r, REQUEST_LONG_SETTLED_BEFORE_THE_WATCH_MS))
    const watcher = requests().watch(dir)
    try {
      await vi.waitFor(() => expect(reply('a')).toEqual({ exit: 0, text: 'late' }), {
        timeout: 5000
      })
      await new Promise((r) => setTimeout(r, REQUEST_LONG_SETTLED_BEFORE_THE_WATCH_MS))
      expect(calls).toHaveLength(1)
    } finally {
      watcher?.close()
    }
  })
})

const REQUEST_LONG_SETTLED_BEFORE_THE_WATCH_MS = 1500
