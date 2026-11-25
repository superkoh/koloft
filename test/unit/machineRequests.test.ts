import { describe, it, expect, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

vi.mock('electron', async () => {
  const nfs = await import('node:fs')
  const nos = await import('node:os')
  const npath = await import('node:path')
  const base = nfs.mkdtempSync(npath.join(nos.tmpdir(), 'koloft-machine-requests-'))
  return { app: { getPath: () => base, getName: () => 'koloft-dev', isPackaged: false } }
})

import { ClaudeBackend, type ClaudeBackendDeps } from '../../src/agents/claude/main/backend'
import { MachineRequests, type MachineRequestDeps } from '../../src/main/remote/machineRequests'
import { NOT_ITS_PASS, replyJson } from '../../src/main/agentRequests'
import { answered, refused } from '../../src/core/command'
import { markStartedBeforeTabPasses, passOf } from '../../src/main/tabPass'
import { mirrorHookDir } from '../../src/main/remote/paths'
import type { RequestCallerState } from '../../src/main/host/machine'

const MACHINE_TABS = {
  'pty-a': { host: 'devbox', tmuxName: 'k-sa' },
  'pty-b': { host: 'devbox', tmuxName: 'k-sb' },
  'pty-c': { host: 'otherbox', tmuxName: 'k-sc' }
} as Record<string, { host: string; tmuxName: string }>

const CODEX_TABS = { 'pty-cx': 'devbox', 'pty-cy': 'otherbox' } as Record<string, string>

const AGY_TABS = {
  'pty-g': { host: 'devbox', tmuxName: 'k-sg', alive: true },
  'pty-g-exited': { host: 'devbox', tmuxName: 'k-sg-exited', alive: false },
  'pty-h': { host: 'otherbox', tmuxName: 'k-sh', alive: true }
} as Record<string, { host: string; tmuxName: string; alive: boolean }>

const agyTabOfTmuxSession = (host: string, name: string): string | undefined =>
  Object.entries(AGY_TABS).find(([, t]) => t.host === host && t.tmuxName === name && t.alive)?.[0]

const WORKBENCH_SHELLS = {
  'pty-wa': { util: true, ownerTabId: 'pty-a' },
  'pty-wcx': { util: true, ownerTabId: 'pty-cx' },
  'pty-wgone': { util: true, ownerTabId: 'pty-gone' }
} as Record<string, { util: boolean; ownerTabId: string }>

function machineBackend(): {
  boundTo: Map<string, string>
  answeredFor: (string | undefined)[]
  sent: [string, string, string | null][]
  callerSeen: (RequestCallerState | undefined)[]
  callerChecks: string[]
  waits: (() => boolean)[]
  release(): void
  drop(name: string, body: unknown): void
} {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-machine-requests-'))
  const boundTo = new Map(Object.keys(MACHINE_TABS).map((id) => [id, `sid-of-${id}`]))
  const answeredFor: (string | undefined)[] = []
  const sent: [string, string, string | null][] = []
  const pty = {
    get: (id: string) =>
      WORKBENCH_SHELLS[id] ??
      (MACHINE_TABS[id] || CODEX_TABS[id]
        ? { alive: true }
        : AGY_TABS[id] && { alive: AGY_TABS[id].alive }),
    clearResumeIntent: () => {}
  }
  const remoteTargets = (): { host: string; paths: string[] }[] => [{ host: 'devbox', paths: [] }]
  const backend = new ClaudeBackend({
    pty,
    tracker: {
      infoOf: (id: string) => (boundTo.has(id) ? { sessionId: boundTo.get(id) } : undefined),
      bindSession: (id: string, _transcript: string, sid: string) => void boundTo.set(id, sid),
      remoteOf: (id: string) => MACHINE_TABS[id],
      setRemoteTmuxName: () => {},
      list: () => Object.keys(MACHINE_TABS).map((tabId) => ({ tabId, alive: true }))
    },
    remoteTargets,
    sessionRebound: () => {},
    store: () => ({
      onSessionStart: () => {},
      onSessionBound: () => {},
      dropOwnership: () => {}
    }),
    userData: () => userData,
    events: () => {}
  } as unknown as ClaudeBackendDeps)
  const callerSeen: (RequestCallerState | undefined)[] = []
  const callerChecks: string[] = []
  const waits: (() => boolean)[] = []
  let release = (): void => {}
  const held = new Promise<void>((r) => (release = r))
  const requests = new MachineRequests({
    pty,
    agentReply: async (tabId: string | undefined, _raw: unknown, stillWaiting?: () => boolean) => {
      answeredFor.push(tabId)
      if (stillWaiting) {
        waits.push(stillWaiting)
        await held
      }
      return answered(`for ${tabId}`)
    },
    hosts: {
      machine: (host: string) => ({
        answerRequest: async (id: string, reply: string | null) =>
          void sent.push([host, id, reply]),
        requestCallerWaits: async (id: string) => {
          callerChecks.push(id)
          return callerSeen.shift()
        }
      })
    },
    remoteTargets,
    userData: () => userData,
    machineOfTab: (id: string) => MACHINE_TABS[id]?.host ?? CODEX_TABS[id] ?? AGY_TABS[id]?.host,
    tabOfTmuxSession: (host: string, name: string) =>
      backend.tabOfTmuxSession(host, name) ?? agyTabOfTmuxSession(host, name)
  } as unknown as MachineRequestDeps)
  backend.watchRemoteHookMirrors()
  requests.watchRemoteHookMirrors()
  const mirrorDir = mirrorHookDir(userData, 'devbox')
  return {
    boundTo,
    answeredFor,
    sent,
    callerSeen,
    callerChecks,
    waits,
    release,
    drop: (name, body) => fs.writeFileSync(path.join(mirrorDir, name), JSON.stringify(body))
  }
}

const A_FEW_MIRROR_PULLS_MS = 1500
const request = (tabId: string, tmux: string, pass: string | null = passOf(tabId)): unknown => ({
  tabId,
  tmux,
  pass,
  argv: ['help'],
  cwd: '/'
})
const keyless = (tabId: string, tmux: string): unknown => request(tabId, tmux, null)

describe('koloft requests from a session on a remote machine', () => {
  // PLATFORM§34
  it('answers a request the hook mirror brings back once on the machine, though every pull writes it again, and never rebinds the tab it names', async () => {
    const m = machineBackend()
    m.drop('req-r1.json', request('pty-a', 'k-sa'))
    m.drop('res-r0.json', { exit: 0, text: 'an answer the mirror pulled back' })
    await vi.waitFor(() => expect(m.sent).toHaveLength(1), { timeout: 5000 })
    for (let i = 0; i < 3; i++) {
      await new Promise((r) => setTimeout(r, A_FEW_MIRROR_PULLS_MS / 3))
      m.drop('req-r1.json', request('pty-a', 'k-sa'))
    }
    m.drop('pty-b.json', { tabId: 'pty-b', event: 'start', source: 'clear', sessionId: 'sid-new' })
    await vi.waitFor(() => expect(m.boundTo.get('pty-b')).toBe('sid-new'), { timeout: 5000 })

    expect(m.sent).toEqual([['devbox', 'r1', replyJson(answered('for pty-a'))]])
    expect(m.boundTo.get('pty-a')).toBe('sid-of-pty-a')
  })

  async function readsWhileTheOwnerIsAsked(
    seen: (RequestCallerState | undefined)[],
    from: unknown = request('pty-a', 'k-sa')
  ): Promise<{ read: boolean[]; sent: [string, string, string | null][]; checks: string[] }> {
    const m = machineBackend()
    m.callerSeen.push(...seen)
    m.drop('req-r11.json', { ...(from as object), pid: 77 })
    await vi.waitFor(() => expect(m.waits).toHaveLength(1), { timeout: 5000 })
    const read: boolean[] = []
    for (let i = 0; i <= seen.length; i++) {
      read.push(m.waits[0]())
      await new Promise((r) => setTimeout(r, 0))
    }
    m.release()
    await vi.waitFor(() => expect(m.sent).toHaveLength(1), { timeout: 5000 })
    return { read, sent: m.sent, checks: m.callerChecks }
  }

  it.each([
    ['a Claude Code tab', request('pty-a', 'k-sa')],
    ['a Codex tab', request('pty-cx', '')],
    ['an Antigravity tab', request('pty-g', 'k-sg')]
  ])(
    'asks the machine whether the koloft command of %s there still waits while its answer waits on the owner, and takes the answer away once it stopped',
    async (_tab, from) => {
      const { read, sent, checks } = await readsWhileTheOwnerIsAsked(['runs', 'gone'], from)
      expect(read).toEqual([true, true, false])
      expect(sent).toEqual([['devbox', 'r11', null]])
      expect(checks).toContain('r11')
    }
  )

  it('reads a koloft command on the machine as no longer waiting once its pid, first seen running koloft, is gone; a pid never seen running koloft, as from another pid namespace, or a broken link keeps it waiting; once it stopped, its answer is taken away instead of written', async () => {
    const { read, sent } = await readsWhileTheOwnerIsAsked([
      'gone',
      undefined,
      'runs',
      undefined,
      'gone'
    ])
    expect(read).toEqual([true, true, true, true, true, false])
    expect(sent).toEqual([['devbox', 'r11', null]])
  })

  it('reads a koloft command on the machine as no longer waiting once its request is gone from there, which an ended command takes with it, even before its pid was ever seen running', async () => {
    const { read, sent } = await readsWhileTheOwnerIsAsked(['gone', 'request-gone'])
    expect(read).toEqual([true, true, false])
    expect(sent).toEqual([['devbox', 'r11', null]])
  })

  it('checks nothing on the machine for a request whose answer never asked the owner, and answers it', async () => {
    const m = machineBackend()
    m.release()
    m.drop('req-r12.json', { ...(request('pty-a', 'k-sa') as object), pid: 78 })
    await vi.waitFor(() => expect(m.sent).toHaveLength(1), { timeout: 5000 })
    expect(m.sent).toEqual([['devbox', 'r12', replyJson(answered('for pty-a'))]])
    expect(m.callerChecks).toEqual([])
  })

  it('answers a request carrying a pass for the tab that pass belongs to, whatever tmux session it names; refuses one naming a tab with another tab’s pass; and leaves one from no tab of its own on that machine unanswered, for the Koloft that owns it', async () => {
    const m = machineBackend()
    m.drop('req-r2.json', request('pty-c', 'k-sc'))
    m.drop('req-r3.json', request('pty-gone', 'k-gone'))
    m.drop('req-r4.json', request('pty-b', 'k-sa'))
    m.drop('req-r5.json', request('pty-b', '', passOf('pty-a')))
    await vi.waitFor(() => expect(m.sent).toHaveLength(2), { timeout: 5000 })
    await new Promise((r) => setTimeout(r, A_FEW_MIRROR_PULLS_MS))

    expect(Object.fromEntries(m.sent.map(([, id, reply]) => [id, reply]))).toEqual({
      r4: replyJson(answered('for pty-b')),
      r5: replyJson(refused(NOT_ITS_PASS))
    })
  })

  it('a request with no pass, as an older Koloft’s koloft sends, is answered only for a session that was already running before Koloft gave tabs a pass, found by its tmux session before its tab id, and only until that tab starts a session of its own; for any other tab of its own it is refused', async () => {
    const m = machineBackend()
    markStartedBeforeTabPasses('pty-a', true)
    m.drop('req-r13.json', keyless('pty-b', 'k-sa'))
    m.drop('req-r14.json', keyless('pty-b', 'k-sb'))
    m.drop('req-r15.json', keyless('pty-gone', 'k-gone'))
    await vi.waitFor(() => expect(m.sent).toHaveLength(2), { timeout: 5000 })
    await new Promise((r) => setTimeout(r, A_FEW_MIRROR_PULLS_MS))

    expect(Object.fromEntries(m.sent.map(([, id, reply]) => [id, reply]))).toEqual({
      r13: replyJson(answered('for pty-a')),
      r14: replyJson(refused(NOT_ITS_PASS))
    })

    markStartedBeforeTabPasses('pty-a', false)
    m.drop('req-r16.json', keyless('pty-a', 'k-sa'))
    await vi.waitFor(() => expect(m.sent).toHaveLength(3), { timeout: 5000 })
    expect(m.sent[2]).toEqual(['devbox', 'r16', replyJson(refused(NOT_ITS_PASS))])
  })

  // ADR-0039
  it('answers a request from a Codex tab on that machine, which names its tab and no tmux session, and leaves one from a Codex tab on another machine unanswered', async () => {
    const m = machineBackend()
    m.drop('req-r6.json', request('pty-cy', ''))
    m.drop('req-r7.json', request('pty-cx', ''))
    await vi.waitFor(() => expect(m.sent).toHaveLength(1), { timeout: 5000 })
    await new Promise((r) => setTimeout(r, A_FEW_MIRROR_PULLS_MS))

    expect(m.sent).toEqual([['devbox', 'r7', replyJson(answered('for pty-cx'))]])
  })

  it('answers a request from an Antigravity tab on that machine carrying its pass, whatever tmux session it names, and leaves one from an Antigravity tab on another machine unanswered', async () => {
    const m = machineBackend()
    m.drop('req-g1.json', request('pty-h', 'k-sh'))
    m.drop('req-g2.json', request('pty-g', 'k-sa'))
    await vi.waitFor(() => expect(m.sent).toHaveLength(1), { timeout: 5000 })
    await new Promise((r) => setTimeout(r, A_FEW_MIRROR_PULLS_MS))

    expect(m.sent).toEqual([['devbox', 'g2', replyJson(answered('for pty-g'))]])
  })

  it('a request with no pass from an Antigravity session that was already running before Koloft gave tabs a pass, naming a tab that is gone, is answered for the Antigravity tab that runs its tmux session on that machine, and refused once that tab no longer counts as started before passes', async () => {
    const m = machineBackend()
    markStartedBeforeTabPasses('pty-g', true)
    m.drop('req-g3.json', keyless('pty-old-agy-tab', 'k-sg'))
    m.drop('req-g4.json', keyless('pty-old-agy-tab', 'k-sh'))
    await vi.waitFor(() => expect(m.sent).toHaveLength(1), { timeout: 5000 })
    await new Promise((r) => setTimeout(r, A_FEW_MIRROR_PULLS_MS))
    expect(m.sent).toEqual([['devbox', 'g3', replyJson(answered('for pty-g'))]])

    markStartedBeforeTabPasses('pty-g', false)
    m.drop('req-g5.json', keyless('pty-old-agy-tab', 'k-sg'))
    await vi.waitFor(() => expect(m.sent).toHaveLength(2), { timeout: 5000 })
    expect(m.sent[1]).toEqual(['devbox', 'g5', replyJson(refused(NOT_ITS_PASS))])
  })

  async function keylessAnswer(tmux: string): Promise<string | null> {
    const m = machineBackend()
    const preTabPasses = ['pty-a', 'pty-g', 'pty-g-exited']
    for (const id of preTabPasses) markStartedBeforeTabPasses(id, true)
    try {
      m.drop('req-r17.json', keyless('pty-a', tmux))
      await vi.waitFor(() => expect(m.sent).toHaveLength(1), { timeout: 5000 })
      return m.sent[0][2]
    } finally {
      for (const id of preTabPasses) markStartedBeforeTabPasses(id, false)
    }
  }

  it('a request with no pass is found by the tmux session it runs in, asked of every agent, before the tab id it names: one in an Antigravity tab’s tmux session naming another live tab on that machine counts as the Antigravity tab', async () => {
    expect(await keylessAnswer('k-sg')).toBe(replyJson(answered('for pty-g')))
  })

  it('a request with no pass in the tmux session of an Antigravity tab whose terminal has exited is found by the tab id it names', async () => {
    expect(await keylessAnswer('k-sg-exited')).toBe(replyJson(answered('for pty-a')))
  })

  it('answers a request from a Workbench shell on that machine as the session tab that owns the shell, Claude or Codex, and one whose owner is gone at once, with no tab, instead of leaving it to time out', async () => {
    const m = machineBackend()
    m.drop('req-r8.json', request('pty-wa', ''))
    m.drop('req-r9.json', request('pty-wcx', ''))
    m.drop('req-r10.json', request('pty-wgone', ''))
    await vi.waitFor(() => expect(m.sent).toHaveLength(3), { timeout: 5000 })

    expect(Object.fromEntries(m.sent.map(([, id, reply]) => [id, reply]))).toEqual({
      r8: replyJson(answered('for pty-a')),
      r9: replyJson(answered('for pty-cx')),
      r10: replyJson(answered('for undefined'))
    })
  })

  it('carries out a request that wants no answer, as a plain open sends, and only takes it away on the machine, even one from no tab of its own', async () => {
    const m = machineBackend()
    m.drop('req-r11.json', { ...(request('pty-a', 'k-sa') as object), reply: false })
    m.drop('req-r12.json', { ...(request('pty-gone', 'k-gone') as object), reply: false })
    await vi.waitFor(() => expect(m.sent).toHaveLength(2), { timeout: 5000 })

    expect(m.sent.sort()).toEqual([
      ['devbox', 'r11', null],
      ['devbox', 'r12', null]
    ])
    expect(m.answeredFor).toEqual(['pty-a'])
  })
})
