import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

vi.mock('node-pty', () => ({ spawn: vi.fn() }))

import { AGENT_GUIDE } from '../../src/shared/agentGuide'
import {
  AGENT_TOOLS_OFF,
  AgentRequests,
  BUILTIN_VERBS,
  answered,
  type AgentCaller,
  type AgentRequestDeps,
  type TabFacts
} from '../../src/main/agentRequests'

const OTHER_LIVE_INSTANCE = process.pid + 1
const tabOf = (pid: number, n: number): string => `pty-${pid.toString(36)}-${n}`

let dir: string
let calls: { args: string[]; caller: AgentCaller }[]
let tabs: Map<string, TabFacts>
let on: boolean

function requests(extra: Partial<AgentRequestDeps> = {}): AgentRequests {
  return new AgentRequests({
    verbs: {
      ...BUILTIN_VERBS,
      echo: (args, caller) => {
        calls.push({ args, caller })
        return answered(args.join(' '))
      }
    },
    tab: (id) => tabs.get(id),
    enabled: () => on,
    alive: (pid) => pid === OTHER_LIVE_INSTANCE,
    ...extra
  })
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
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('koloft requests from a session', () => {
  it('help, or no command at all, answers with the guide', async () => {
    const r = requests()
    const tabId = tabOf(process.pid, 1)
    await r.answer(dir, 'req-a.json', { tabId, argv: ['help'], cwd: '/w' })
    await r.answer(dir, 'req-b.json', { tabId, argv: [], cwd: '/w' })
    expect(reply('a')).toEqual({ ok: true, exit: 0, text: AGENT_GUIDE })
    expect(reply('b')).toEqual({ ok: true, exit: 0, text: AGENT_GUIDE })
  })

  it('an unknown command is refused with exit code 2 and points at koloft help', async () => {
    const tabId = tabOf(process.pid, 1)
    await requests().answer(dir, 'req-a.json', { tabId, argv: ['frobnicate', 'x'], cwd: '/w' })
    await requests().answer(dir, 'req-b.json', { tabId, argv: ['constructor'], cwd: '/w' })
    for (const id of ['a', 'b']) {
      expect(reply(id)).toEqual({
        ok: false,
        exit: 2,
        text: expect.stringContaining('koloft help')
      })
    }
  })

  it('hands the command its words after the verb and the session tab it came from', async () => {
    const tabId = tabOf(process.pid, 1)
    await requests().answer(dir, 'req-a.json', { tabId, argv: ['echo', 'a b', 'c'], cwd: '/w' })
    expect(calls).toEqual([{ args: ['a b', 'c'], caller: { tabId, cwd: '/w' } }])
    expect(reply('a')).toEqual({ ok: true, exit: 0, text: 'a b c' })
  })

  it('a request typed in a Workbench shell acts for the session tab that shell belongs to', async () => {
    const owner = tabOf(process.pid, 1)
    const shell = tabOf(process.pid, 2)
    tabs.set(shell, { util: true, ownerTabId: owner })
    await requests().answer(dir, 'req-a.json', { tabId: shell, argv: ['echo'], cwd: '/w' })
    expect(calls.map((c) => c.caller.tabId)).toEqual([owner])
  })

  it("leaves another running Koloft's request untouched, and answers one whose Koloft is gone", async () => {
    const theirs = tabOf(OTHER_LIVE_INSTANCE, 1)
    drop('req-a.json', { tabId: theirs, argv: ['echo'], cwd: '/w' })
    await requests().answer(dir, 'req-a.json', { tabId: theirs, argv: ['echo'], cwd: '/w' })
    expect(fs.existsSync(path.join(dir, 'req-a.json'))).toBe(true)
    expect(reply('a')).toBeNull()

    const orphan = tabOf(process.pid + 2, 1)
    await requests().answer(dir, 'req-b.json', { tabId: orphan, argv: ['echo'], cwd: '/w' })
    expect(reply('b')).toEqual({ ok: false, exit: 1, text: expect.any(String) })
    expect(calls).toEqual([])
  })

  it('refuses every command while agent tools are off', async () => {
    on = false
    const tabId = tabOf(process.pid, 1)
    await requests().answer(dir, 'req-a.json', { tabId, argv: ['echo'], cwd: '/w' })
    expect(reply('a')).toEqual({ ok: false, exit: 1, text: AGENT_TOOLS_OFF })
    expect(calls).toEqual([])
  })

  it('runs a request delivered twice only once, so a command never takes effect twice', async () => {
    const r = requests()
    const body = { tabId: tabOf(process.pid, 1), argv: ['echo'], cwd: '/w' }
    await Promise.all([r.answer(dir, 'req-a.json', body), r.answer(dir, 'req-a.json', body)])
    expect(calls).toHaveLength(1)
  })

  it('a Codex request carries no tab id: it is answered for the tab its folder belongs to', async () => {
    const tabId = tabOf(process.pid, 1)
    await requests().answerFor(tabId, dir, 'req-a.json', { argv: ['echo'], cwd: '/w' })
    await requests().answerFor(undefined, dir, 'req-b.json', { argv: ['echo'], cwd: '/w' })
    expect(calls.map((c) => c.caller.tabId)).toEqual([tabId])
    expect(reply('b')).toEqual({ ok: false, exit: 1, text: expect.any(String) })
  })
})
