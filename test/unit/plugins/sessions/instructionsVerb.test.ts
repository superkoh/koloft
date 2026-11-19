import { describe, expect, it, vi } from 'vitest'
import type { SessionDefaults, SessionInfo } from '../../../../src/shared/types'
import { OWNER } from '../../../../src/core/ownerInstructions'
import {
  A_HELPER_ONLY_PROPOSES_FOR_THE_BUTLER,
  ONLY_ITS_OWN_WORKSPACE,
  instructionsVerb
} from '../../../../src/plugins/sessions/main/instructionsVerb'
import {
  InstructionAsks,
  type OwnersAnswer
} from '../../../../src/plugins/sessions/main/instructionAsks'
import { workspaceBlock } from '../../../../src/plugins/sessions/api'
import { butlersBlock } from '../../../../src/plugins/butler/api'
import { WORKSPACE_TEXT_MAX_BYTES } from '../../../../src/plugins/sessions/shared/workspaceInstructions'
import type { InstructionAskView } from '../../../../src/plugins/sessions/shared/instructionAsks'
import type { ButlerSetting } from '../../../../src/plugins/butler/shared/types'

const WS_A = '/Users/me/ws-a'
const WS_B = '/Users/me/ws-b'
const BUTLER_TAB = 'tab-butler'
const HELPER_TAB = 'tab-helper'
const AT = 1_700_000_000_000
const TITLES: Record<string, string> = {
  [BUTLER_TAB]: 'Alfred',
  [HELPER_TAB]: 'Helper',
  'tab-untitled': ''
}

function world(answer: OwnersAnswer = 'agreed') {
  const defaults = new Map<string, SessionDefaults>([
    [WS_A, { picks: {}, instructions: [{ text: 'Answer in Chinese.', at: 1, by: OWNER }] }]
  ])
  const butler = { value: { name: 'Alfred' } as ButlerSetting }
  const asked: Omit<InstructionAskView, 'id'>[] = []
  const store = {
    read: async (dir: string) => defaults.get(dir) ?? { picks: {} },
    write: async (
      dir: string,
      next: (saved: SessionDefaults | undefined) => SessionDefaults | undefined
    ) => {
      const kept = next(defaults.get(dir))
      if (kept) defaults.set(dir, kept)
      else defaults.delete(dir)
    }
  }
  const w = { onAsk: (): void => undefined }
  const verb = instructionsVerb({
    askTheOwner: async (ask) => {
      asked.push(ask)
      w.onAsk()
      return answer
    },
    overseerSide: (tabId) => tabId === BUTLER_TAB || tabId === HELPER_TAB,
    isOverseer: (tabId) => tabId === BUTLER_TAB,
    overseerBlock: () =>
      butlersBlock(
        () => butler.value,
        (b) => (butler.value = b),
        () => AT
      ),
    workspaceOf: (tabId) =>
      tabId === 'tab-b' ? WS_B : tabId === BUTLER_TAB || tabId === HELPER_TAB ? undefined : WS_A,
    pinnedWorkspaces: () => [
      { path: WS_A, missing: false },
      { path: WS_B, missing: false }
    ],
    workspaceBlock: (ws) => workspaceBlock(store, ws, () => AT),
    nameOf: (s) => s.title || 'Codex'
  })
  const run = (tabId: string, args: string[]) =>
    verb(args, {
      tabId,
      cwd: '/',
      session: { tabId, title: TITLES[tabId] ?? 'Fix login' } as SessionInfo
    })
  return Object.assign(w, { defaults, butler, asked, run })
}

describe('koloft instructions asks the owner before anything changes', () => {
  it("a session's line is shown to the owner in that session's own tab, and once the owner agrees it is added as a version that names the session", async () => {
    const w = world()
    const r = await w.run('tab-a', ['add', '--', 'Run npm test first.'])
    expect(w.asked).toEqual([
      {
        tabId: 'tab-a',
        by: 'Fix login',
        what: 'the instructions of workspace ws-a',
        before: 'Answer in Chinese.',
        after: 'Answer in Chinese.\nRun npm test first.'
      }
    ])
    expect(r.exit).toBe(0)
    expect(w.defaults.get(WS_A)?.instructions?.at(-1)).toEqual({
      text: 'Answer in Chinese.\nRun npm test first.',
      at: AT,
      by: 'Fix login'
    })
  })

  it.each([
    ['declined', /did not agree/],
    ['timeout', /did not answer in time/],
    ['closed', /stopped waiting, or this session was closed, before the owner answered/]
  ] as const)('when the owner %s, nothing changes and the agent is told so', async (how, said) => {
    const w = world(how)
    const r = await w.run('tab-a', ['set', '--', 'Be brief.'])
    expect(r.exit).toBe(1)
    expect(r.text).toMatch(said)
    expect(w.defaults.get(WS_A)?.instructions).toHaveLength(1)
  })

  it('writes nothing when the text changed while the owner was being asked', async () => {
    const w = world()
    w.onAsk = () =>
      w.defaults.set(WS_A, {
        picks: {},
        instructions: [{ text: 'Owner changed it meanwhile.', at: 2, by: OWNER }]
      })
    const r = await w.run('tab-a', ['add', '--', 'x'])
    expect(r.exit).toBe(1)
    expect(r.text).toMatch(/changed while the owner was asked/)
    expect(w.defaults.get(WS_A)?.instructions?.at(-1)?.text).toBe('Owner changed it meanwhile.')
  })

  it('does not ask when the text would not change (a line it already has, or the same whole text), nor when it would go past the limit', async () => {
    const w = world()
    expect((await w.run('tab-a', ['set', '--', 'Answer in Chinese.'])).text).toMatch(
      /already say that/
    )
    expect((await w.run('tab-a', ['add', '--', 'Answer in Chinese.'])).text).toMatch(
      /already say that/
    )
    await expect(
      w.run('tab-a', ['set', '--', 'a'.repeat(WORKSPACE_TEXT_MAX_BYTES + 1)])
    ).rejects.toThrow('The rules and instructions together are 1 over the limit.')
    expect(w.asked).toEqual([])
  })

  it("a session cannot read or change another workspace's instructions", async () => {
    const w = world()
    expect(await w.run('tab-b', ['add', '--workspace', 'ws-a', '--', 'x'])).toEqual({
      text: ONLY_ITS_OWN_WORKSPACE,
      exit: 1
    })
    expect((await w.run('tab-b', ['--workspace', 'ws-a'])).exit).toBe(1)
    expect(w.asked).toEqual([])
  })

  it("the butler proposes changes to its own instructions and to any workspace's, each asked in its own tab", async () => {
    const w = world()
    await w.run(BUTLER_TAB, ['add', '--', 'Ask me before any merge.'])
    await w.run(BUTLER_TAB, ['add', '--workspace', 'ws-b', '--', 'Commit in English.'])
    expect(w.asked.map((a) => [a.tabId, a.what])).toEqual([
      [BUTLER_TAB, "Alfred's instructions"],
      [BUTLER_TAB, 'the instructions of workspace ws-b']
    ])
    expect(w.butler.value.instructions?.at(-1)).toEqual({
      text: 'Ask me before any merge.',
      at: AT,
      by: 'Alfred'
    })
    expect(w.defaults.get(WS_B)?.instructions?.at(-1)?.text).toBe('Commit in English.')
  })

  it("a helper of the butler proposes changes to the butler's instructions in its own tab, but not to a workspace's", async () => {
    const w = world()
    await w.run(HELPER_TAB, ['add', '--', 'Ask me before any merge.'])
    expect(w.asked.map((a) => [a.tabId, a.by])).toEqual([[HELPER_TAB, 'Helper']])
    expect(w.butler.value.instructions?.at(-1)?.by).toBe('Helper')
    expect(await w.run(HELPER_TAB, ['add', '--workspace', 'ws-a', '--', 'x'])).toEqual({
      text: A_HELPER_ONLY_PROPOSES_FOR_THE_BUTLER,
      exit: 1
    })
    expect((await w.run(HELPER_TAB, ['--workspace', 'ws-a'])).exit).toBe(0)
  })

  it('a session with no title is named by its agent', async () => {
    const w = world()
    await w.run('tab-untitled', ['add', '--', 'x'])
    expect(w.asked[0].by).toBe('Codex')
  })

  it.each([[['add']], [['add', '--']], [['set']], [['remove', '--', 'x']], [['--workspace']]])(
    'answers a malformed call %j with its usage',
    async (args) => {
      expect((await world().run('tab-a', args)).exit).toBe(2)
    }
  )
})

describe("the owner's answer, kept until it comes", () => {
  it("marks the session as waiting on the owner while it asks, shows each ask, and lets go of the session's ask when its tab ends", async () => {
    const shown: number[] = []
    const marks: string[] = []
    const asks = new InstructionAsks({
      show: (views) => shown.push(views.length),
      owner: {
        waitsOnTheOwner: (tab) => marks.push(`waits ${tab}`),
        ownerAnswered: (tab) => marks.push(`answered ${tab}`)
      }
    })
    const ask = { tabId: 't1', by: 'x', what: 'y', before: '', after: 'z' }
    const first = asks.ask(ask, 60_000)
    const second = asks.ask({ ...ask, tabId: 't2' }, 60_000)
    asks.answer(asks.views()[0].id, true)
    asks.forget('t2')
    expect(await first).toBe('agreed')
    expect(await second).toBe('closed')
    expect(shown).toEqual([1, 2, 1, 0])
    expect(marks).toEqual(['waits t1', 'waits t2', 'answered t1', 'answered t2'])
  })

  it('ends an ask whose command stopped waiting (the agent gave up or was interrupted), and follows its session to a new tab', async () => {
    vi.useFakeTimers()
    try {
      let waiting = true
      const asks = new InstructionAsks({
        show: () => undefined,
        owner: { waitsOnTheOwner: () => undefined, ownerAnswered: () => undefined }
      })
      const given = asks.ask(
        { tabId: 't1', by: 'x', what: 'y', before: '', after: 'z' },
        60_000,
        () => waiting
      )
      asks.rehome('t1', 't9')
      expect(asks.views().map((v) => v.tabId)).toEqual(['t9'])
      waiting = false
      await vi.advanceTimersByTimeAsync(5000)
      expect(await given).toBe('closed')
    } finally {
      vi.useRealTimers()
    }
  })
})
