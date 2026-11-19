import { describe, expect, it } from 'vitest'
import type { SessionDefaults, SessionInfo } from '../../../../src/shared/types'
import { OWNER, unseenChange, withNewVersion } from '../../../../src/core/ownerInstructions'
import {
  ONLY_ITS_OWN_WORKSPACE,
  instructionsVerb,
  type InstructionsChanged
} from '../../../../src/plugins/sessions/main/instructionsVerb'
import {
  savedFromTheDialog,
  seenDefaults,
  undoneDefaults,
  workspaceBlock
} from '../../../../src/plugins/sessions/api'
import { butlersBlock } from '../../../../src/plugins/butler/api'
import { WORKSPACE_TEXT_MAX_BYTES } from '../../../../src/plugins/sessions/shared/workspaceInstructions'
import type { ButlerSetting } from '../../../../src/plugins/butler/shared/types'

const WS_A = '/Users/me/ws-a'
const WS_B = '/Users/me/ws-b'
const BUTLER_TAB = 'tab-butler'
const AT = 1_700_000_000_000

function world(): {
  defaults: Map<string, SessionDefaults>
  butler: { value: ButlerSetting }
  told: InstructionsChanged[]
  run: (tabId: string, args: string[]) => ReturnType<ReturnType<typeof instructionsVerb>>
} {
  const defaults = new Map<string, SessionDefaults>([
    [WS_A, { picks: {}, instructions: [{ text: 'Answer in Chinese.', at: 1, by: OWNER }] }]
  ])
  const butler = { value: { name: 'Alfred' } as ButlerSetting }
  const told: InstructionsChanged[] = []
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
  const verb = instructionsVerb({
    changed: async (c) => {
      told.push(c)
      return []
    },
    overseerSide: (tabId) => tabId === BUTLER_TAB,
    overseerBlock: () =>
      butlersBlock(
        butler.value,
        (b) => (butler.value = b),
        () => AT
      ),
    workspaceOf: (tabId) => (tabId === 'tab-b' ? WS_B : tabId === BUTLER_TAB ? undefined : WS_A),
    pinnedWorkspaces: () => [
      { path: WS_A, missing: false },
      { path: WS_B, missing: false }
    ],
    workspaceBlock: (ws) => workspaceBlock(store, ws, () => AT),
    nameOf: (s) => s.title || 'Codex'
  })
  const TITLES: Record<string, string> = { [BUTLER_TAB]: 'Alfred', 'tab-untitled': '' }
  const run = (tabId: string, args: string[]) =>
    verb(args, {
      tabId,
      cwd: '/',
      session: { tabId, title: TITLES[tabId] ?? 'Fix login' } as SessionInfo
    })
  return { defaults, butler, told, run }
}

describe('koloft instructions', () => {
  it("a session adds a line to its own workspace's instructions, kept as a new version that names the session and waits for the owner to see it", async () => {
    const w = world()
    const r = await w.run('tab-a', ['add', '--', 'Run npm test first.'])
    expect(r.exit).toBe(0)
    expect(w.defaults.get(WS_A)?.instructions?.at(-1)).toEqual({
      text: 'Answer in Chinese.\nRun npm test first.',
      at: AT,
      by: 'Fix login',
      agent: true,
      unseen: true
    })
    expect((await w.run('tab-a', [])).text).toBe('Answer in Chinese.\nRun npm test first.')
  })

  it('set replaces the whole text, and an empty set clears it', async () => {
    const w = world()
    await w.run('tab-a', ['set', '--', 'Be brief.'])
    expect(w.defaults.get(WS_A)?.instructions?.at(-1)?.text).toBe('Be brief.')
    await w.run('tab-a', ['set', '--'])
    expect(w.defaults.get(WS_A)?.instructions?.at(-1)?.text).toBe('')
  })

  it("a session cannot read or change another workspace's instructions", async () => {
    const w = world()
    expect(await w.run('tab-b', ['add', '--workspace', 'ws-a', '--', 'x'])).toEqual({
      text: ONLY_ITS_OWN_WORKSPACE,
      exit: 1
    })
    expect((await w.run('tab-b', ['--workspace', 'ws-a'])).exit).toBe(1)
    expect(w.defaults.get(WS_A)?.instructions).toHaveLength(1)
  })

  it("the butler changes its own instructions without --workspace, and any workspace's with it", async () => {
    const w = world()
    await w.run(BUTLER_TAB, ['add', '--', 'Ask me before any merge.'])
    expect(w.butler.value.instructions?.at(-1)).toEqual({
      text: 'Ask me before any merge.',
      at: AT,
      by: 'Alfred',
      agent: true,
      unseen: true
    })
    await w.run(BUTLER_TAB, ['add', '--workspace', 'ws-b', '--', 'Commit in English.'])
    expect(w.defaults.get(WS_B)?.instructions?.at(-1)?.text).toBe('Commit in English.')
  })

  it("refuses a change past the workspace's limit, and keeps the text as it was", async () => {
    const w = world()
    await expect(
      w.run('tab-a', ['set', '--', 'a'.repeat(WORKSPACE_TEXT_MAX_BYTES + 1)])
    ).rejects.toThrow('The rules and instructions together are 1 over the limit.')
    expect(w.defaults.get(WS_A)?.instructions).toHaveLength(1)
  })

  it('records no version and tells no one when the text does not change', async () => {
    const w = world()
    await w.run('tab-a', ['set', '--', 'Answer in Chinese.'])
    expect(w.defaults.get(WS_A)?.instructions).toHaveLength(1)
    expect(w.told).toEqual([])
  })

  it('tells the owner who changed which block', async () => {
    const w = world()
    await w.run('tab-a', ['add', '--', 'x'])
    await w.run(BUTLER_TAB, ['add', '--', 'y'])
    expect(w.told).toEqual([
      {
        workspace: WS_A,
        by: 'Fix login',
        notice: '"Fix login" changed the instructions of workspace ws-a.'
      },
      { workspace: undefined, by: 'Alfred', notice: 'Alfred changed its instructions.' }
    ])
  })
})

describe('the owner sees and undoes an agent’s change', () => {
  it('seeing it clears the mark; undoing it brings back the text before it, as a new version by the owner', async () => {
    const w = world()
    await w.run('tab-a', ['add', '--', 'Run npm test first.'])
    const change = unseenChange(w.defaults.get(WS_A)?.instructions)!
    const saved = seenDefaults(w.defaults.get(WS_A))
    expect(saved?.instructions?.some((v) => v.unseen)).toBe(false)
    const undone = undoneDefaults(saved, change, AT + 5)
    expect(undone?.instructions?.at(-1)).toEqual({
      text: 'Answer in Chinese.',
      at: AT + 5,
      by: OWNER
    })
  })

  it('two changes made before the owner looks are shown and undone together, naming both sessions', async () => {
    const w = world()
    await w.run('tab-a', ['add', '--', 'one'])
    await w.run('tab-untitled', ['add', '--', 'two'])
    const change = unseenChange(w.defaults.get(WS_A)?.instructions)!
    expect(change).toEqual({
      by: 'Fix login, Codex',
      at: AT,
      before: 'Answer in Chinese.',
      after: 'Answer in Chinese.\none\ntwo'
    })
    expect(undoneDefaults(w.defaults.get(WS_A), change, AT + 5)?.instructions?.at(-1)?.text).toBe(
      'Answer in Chinese.'
    )
  })

  it('undoes only that change: once the owner changed the text again, nothing is undone', async () => {
    const w = world()
    await w.run('tab-a', ['add', '--', 'one'])
    const change = unseenChange(w.defaults.get(WS_A)?.instructions)!
    const ownerSaved = savedFromTheDialog(
      w.defaults.get(WS_A),
      { picks: {}, instructions: 'mine' },
      AT + 1
    )
    expect(() => undoneDefaults(ownerSaved, change, AT + 5)).toThrow(/changed again/)
  })

  it('a session with no title, or one titled "owner", is still recorded as an agent', async () => {
    const w = world()
    await w.run('tab-untitled', ['add', '--', 'x'])
    expect(w.defaults.get(WS_A)?.instructions?.at(-1)).toMatchObject({
      by: 'Codex',
      agent: true,
      unseen: true
    })
    expect(withNewVersion([], 'y', 1, OWNER)).toEqual([
      { text: 'y', at: 1, by: OWNER, agent: true, unseen: true }
    ])
  })

  it.each([[['add']], [['add', '--']], [['set']], [['remove', '--', 'x']], [['--workspace']]])(
    'answers a malformed call %j with its usage',
    async (args) => {
      expect((await world().run('tab-a', args)).exit).toBe(2)
    }
  )
})
