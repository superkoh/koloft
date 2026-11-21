import { describe, expect, it, vi } from 'vitest'
import type { SessionDefaults, SessionInfo } from '../../../../src/shared/types'
import { OWNER, type InstructionsVersion } from '../../../../src/core/ownerInstructions'
import {
  A_HELPER_ONLY_PROPOSES_FOR_THE_BUTLER,
  ONLY_ITS_OWN_WORKSPACE,
  instructionsVerb
} from '../../../../src/plugins/sessions/main/instructionsVerb'
import {
  InstructionAsks,
  type InstructionAsk,
  type InstructionAskEnd,
  type OwnersAnswer
} from '../../../../src/plugins/sessions/main/instructionAsks'
import { everyWorkspaceBlock, workspaceBlock } from '../../../../src/plugins/sessions/api'
import { butlersBlock } from '../../../../src/plugins/butler/api'
import {
  WORKSPACE_TEXT_MAX_BYTES,
  workspaceTextBytes
} from '../../../../src/plugins/sessions/shared/workspaceInstructions'
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
  const everyWorkspace = { value: [] as InstructionsVersion[] }
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
    askTheOwner: async (ask, write) => {
      asked.push(ask)
      w.onAsk()
      if (answer !== 'agreed') return answer
      return (await write()) ? 'agreed' : 'changed-meanwhile'
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
    everyWorkspaceBlock: () =>
      everyWorkspaceBlock(
        () => everyWorkspace.value,
        (v) => (everyWorkspace.value = v),
        () => AT
      ),
    nameOf: (s) => s.title || 'Codex'
  })
  const run = (tabId: string, args: string[]) =>
    verb(args, {
      tabId,
      cwd: '/',
      session: { tabId, title: TITLES[tabId] ?? 'Fix login' } as SessionInfo
    })
  return Object.assign(w, { defaults, butler, everyWorkspace, asked, run })
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

  it("counts the workspace's rules for picking a model toward the limit, so text that fits alone is refused beside them", async () => {
    const w = world()
    const rules = 'Docs: sonnet.'
    w.defaults.set(WS_A, { ...w.defaults.get(WS_A)!, rules })
    const fitsAlone = 'a'.repeat(WORKSPACE_TEXT_MAX_BYTES - workspaceTextBytes(rules, '') + 3)
    await expect(w.run('tab-a', ['set', '--', fitsAlone])).rejects.toThrow(
      'The rules and instructions together are 3 over the limit.'
    )
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

  it.each([
    ['a session in a workspace', 'tab-a', 'Fix login'],
    ['the butler', BUTLER_TAB, 'Alfred'],
    ['a helper of the butler', HELPER_TAB, 'Helper']
  ])(
    '%s reads the instructions for every workspace and proposes a change to them, asked in its own tab as a change for every workspace',
    async (_, tabId, by) => {
      const w = world()
      expect(await w.run(tabId, ['--every-workspace'])).toEqual({
        text: 'The instructions for every workspace are empty.',
        exit: 0
      })
      const r = await w.run(tabId, ['add', '--every-workspace', '--', 'Answer in Chinese.'])
      expect(w.asked).toEqual([
        {
          tabId,
          by,
          what: 'the instructions for every workspace',
          before: '',
          after: 'Answer in Chinese.',
          forEveryWorkspace: true
        }
      ])
      expect(r.text).toBe(
        'The owner agreed: added to the instructions for every workspace. Sessions started from now on follow it.'
      )
      expect(w.everyWorkspace.value).toEqual([{ text: 'Answer in Chinese.', at: AT, by }])
      expect(w.defaults.get(WS_A)?.instructions).toHaveLength(1)
    }
  )

  it('leaves the instructions for every workspace as they were when the owner does not agree', async () => {
    const w = world('declined')
    const r = await w.run('tab-a', ['set', '--every-workspace', '--', 'Be brief.'])
    expect(r.exit).toBe(1)
    expect(w.everyWorkspace.value).toEqual([])
  })

  it('a session with no title is named by its agent', async () => {
    const w = world()
    await w.run('tab-untitled', ['add', '--', 'x'])
    expect(w.asked[0].by).toBe('Codex')
  })

  it.each([
    [['add']],
    [['add', '--']],
    [['set']],
    [['remove', '--', 'x']],
    [['--workspace']],
    [['add', '--every-workspace', '--workspace', 'ws-a', '--', 'x']]
  ])('answers a malformed call %j with its usage', async (args) => {
    expect((await world().run('tab-a', args)).exit).toBe(2)
  })
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
      },
      told: () => undefined
    })
    const first = asks.ask(ASK, 60_000, WRITES)
    const second = asks.ask({ ...ASK, tabId: 't2' }, 60_000, WRITES)
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
      const { asks, ended } = listened()
      const given = asks.ask(ASK, 60_000, WRITES, () => waiting)
      asks.rehome('t1', 't9')
      expect(asks.views().map((v) => v.tabId)).toEqual(['t9'])
      waiting = false
      await vi.advanceTimersByTimeAsync(5000)
      expect(await given).toBe('closed')
      expect(ended).toEqual([{ how: 'stopped-waiting' }])
    } finally {
      vi.useRealTimers()
    }
  })

  it('tells who listens (Discord) when an ask opens, and where the owner answered it once the write is done: on the phone or at the computer', async () => {
    const { asks, asked, ended } = listened()
    let finishWrite!: (ok: boolean) => void
    const writing = new Promise<boolean>((resolve) => (finishWrite = resolve))
    const fromPhone = asks.ask(ASK, 60_000, () => writing)
    expect(asked).toEqual([ASK])
    asks.answer(asks.views()[0].id, true, 'phone')
    expect(asks.views()).toEqual([])
    await Promise.resolve()
    expect(ended).toEqual([])
    finishWrite(true)
    expect(await fromPhone).toBe('agreed')
    const atTheMac = asks.ask(ASK, 60_000, WRITES)
    asks.answer(asks.views()[0].id, false)
    expect(await atTheMac).toBe('declined')
    expect(ended).toEqual([
      { how: 'changed', at: 'phone' },
      { how: 'not-changed', at: 'computer' }
    ])
  })

  it('when the owner agrees but the text changed meanwhile, nothing is written and the owner is told at the Mac too', async () => {
    const { asks, ended, told } = listened()
    const given = asks.ask(ASK, 60_000, async () => false)
    asks.answer(asks.views()[0].id, true)
    expect(await given).toBe('changed-meanwhile')
    expect(ended).toEqual([{ how: 'changed-meanwhile', at: 'computer' }])
    expect(told).toEqual(['The instructions changed meanwhile, so nothing changed.'])
  })

  it('a write that fails after the owner agreed still ends the ask for every listener, tells the owner why, and reaches the agent as that error', async () => {
    const { asks, ended, told } = listened()
    const unreachable = new Error('Koloft cannot reach this machine now.')
    const given = asks.ask(ASK, 60_000, async () => {
      throw unreachable
    })
    asks.answer(asks.views()[0].id, true, 'phone')
    await expect(given).rejects.toBe(unreachable)
    expect(ended).toEqual([{ how: 'write-failed', at: 'phone', error: unreachable }])
    expect(told).toEqual(['Koloft cannot reach this machine now.'])
  })

  it('a closed tab ends its asks before forget returns, so a card is changed before its room is put away', () => {
    const { asks, ended } = listened()
    void asks.ask(ASK, 60_000, WRITES)
    asks.forget('t1')
    expect(ended).toEqual([{ how: 'tab-closed' }])
  })

  it('an ask nobody answers in time ends as timed out for every listener', async () => {
    vi.useFakeTimers()
    try {
      const { asks, ended } = listened()
      const given = asks.ask(ASK, 60_000, WRITES)
      await vi.advanceTimersByTimeAsync(60_000)
      expect(await given).toBe('timeout')
      expect(ended).toEqual([{ how: 'timeout' }])
    } finally {
      vi.useRealTimers()
    }
  })
})

const ASK = { tabId: 't1', by: 'x', what: 'y', before: '', after: 'z' }
const WRITES = async (): Promise<boolean> => true

function listened() {
  const asked: InstructionAsk[] = []
  const ended: InstructionAskEnd[] = []
  const told: string[] = []
  const asks = new InstructionAsks({
    show: () => undefined,
    owner: { waitsOnTheOwner: () => undefined, ownerAnswered: () => undefined },
    told: (text) => void told.push(text)
  })
  asks.listen({
    asked: (_id, ask) => void asked.push(ask),
    ended: (_id, end) => void ended.push(end)
  })
  return { asks, asked, ended, told }
}
