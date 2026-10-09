import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { SessionStatus } from '../../src/shared/types'
import {
  MORE_OUTPUT_SETTLES_MS,
  NOTHING_CAME_BACK_MS,
  SlashCommands,
  type SlashDeps
} from '../../src/main/discord/slash'

const TAB = 'pty-child-1'
const turnIsOver = (s: SessionStatus): boolean => s === 'waiting' || s === 'idle'
const CHANNEL = '222'

function setup(over: Partial<SlashDeps> = {}) {
  let status: SessionStatus = 'waiting'
  let key = 'session-1'
  const typed: string[] = []
  const posts: string[] = []
  const deps: SlashDeps = {
    backendOf: () => 'claude',
    keyOf: () => key,
    turnOver: () => turnIsOver(status),
    asking: () => false,
    takesTyping: () => turnIsOver(status),
    panelOpen: async () => undefined,
    nextMirrorPull: () => undefined,
    ready: async (_t, ready) => ready(),
    exclusive: (_t, typing) => typing(),
    typeNow: async (_t, keys) => void typed.push(...keys),
    post: (_c, text) => void posts.push(text),
    card: (_c, card) => void posts.push(`${card.header}\n${card.body}`),
    ...over
  }
  const slash = new SlashCommands(deps)
  return {
    slash,
    typed,
    posts,
    setStatus: (s: SessionStatus) => {
      status = s
      slash.turnOver(TAB, turnIsOver(s))
    },
    setKey: (k: string) => {
      key = k
    }
  }
}

const child = { name: 'fix-login', tabId: TAB, conductor: false }

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('a slash command typed into a session', () => {
  it('is typed, then Esc closes the command menu, so Enter runs exactly what was typed and not the menu’s first entry', async () => {
    const { slash, typed } = setup()
    await slash.typeWhenIdle(child, '/co', CHANNEL)
    expect(typed).toEqual(['/co', '\x1b', '\r'])
  })

  it('in Codex, the box is emptied first, since an earlier unknown command stays in it', async () => {
    const { slash, typed } = setup({ backendOf: () => 'codex' })
    await slash.typeWhenIdle(child, '/compact', CHANNEL)
    expect(typed).toEqual(['\x05\x15', '/compact', '\x1b', '\r'])
  })

  it('posts what the command printed once no more output follows, and counts as running until then', async () => {
    const { slash, posts } = setup()
    await slash.typeWhenIdle(child, '/cost', CHANNEL)
    slash.output(TAB, { kind: 'printed', text: 'Total cost: $0.01' })
    expect(posts).toEqual([])
    expect(slash.running(TAB)).toBe(true)
    await vi.advanceTimersByTimeAsync(MORE_OUTPUT_SETTLES_MS)
    expect(posts).toEqual(['⌨️ **fix-login** ran /cost:\nTotal cost: $0.01'])
    expect(slash.running(TAB)).toBe(false)
  })

  it('prefers the clean details a command adds over what it printed on screen', async () => {
    const { slash, posts } = setup()
    await slash.typeWhenIdle(child, '/context', CHANNEL)
    slash.output(TAB, { kind: 'printed', text: 'Context Usage ⛁ ⛁ ⛀' })
    slash.output(TAB, { kind: 'details', text: '## Context Usage\n**Tokens:** 28.5k / 200k' })
    await vi.advanceTimersByTimeAsync(MORE_OUTPUT_SETTLES_MS)
    expect(posts[0]).toBe(
      '⌨️ **fix-login** ran /context:\n## Context Usage\n**Tokens:** 28.5k / 200k'
    )
  })

  it('waits for a turn the command started and posts its reply', async () => {
    const { slash, posts, setStatus } = setup()
    await slash.typeWhenIdle(child, '/review', CHANNEL)
    setStatus('working')
    await vi.advanceTimersByTimeAsync(NOTHING_CAME_BACK_MS + MORE_OUTPUT_SETTLES_MS)
    expect(posts).toEqual([])
    slash.turnEnded(TAB, { said: [], reply: 'All good.', at: Date.now() })
    setStatus('waiting')
    await vi.advanceTimersByTimeAsync(MORE_OUTPUT_SETTLES_MS)
    expect(posts).toEqual(['⌨️ **fix-login** ran /review:\nAll good.'])
  })

  it('does not take the reply of the turn before it, whose end Koloft learns only after the command was typed', async () => {
    const { slash, posts, setStatus } = setup()
    const before = Date.now()
    await vi.advanceTimersByTimeAsync(1000)
    await slash.typeWhenIdle(child, '/compact', CHANNEL)
    slash.output(TAB, { kind: 'printed', text: 'Compacted' })
    slash.turnEnded(TAB, { said: [], reply: 'MANGO', at: before })
    setStatus('working')
    setStatus('waiting')
    await vi.advanceTimersByTimeAsync(MORE_OUTPUT_SETTLES_MS)
    expect(posts).toEqual(['⌨️ **fix-login** ran /compact:\nCompacted'])
  })

  it('a turn with nothing said, like a Codex compaction, is reported as done', async () => {
    const { slash, posts, setStatus } = setup({ backendOf: () => 'codex' })
    await slash.typeWhenIdle(child, '/compact', CHANNEL)
    setStatus('working')
    setStatus('waiting')
    await vi.advanceTimersByTimeAsync(MORE_OUTPUT_SETTLES_MS)
    expect(posts).toEqual(['⌨️ **fix-login** ran /compact:\nDone.'])
  })

  it('in a remote tab, waits after the turn ends for one more mirror pull, so output the transcript brings late, like "Compacted", is in the card', async () => {
    let pulled: () => void = () => undefined
    const { slash, posts, setStatus } = setup({
      nextMirrorPull: () => new Promise((done) => (pulled = done))
    })
    await slash.typeWhenIdle(child, '/compact', CHANNEL)
    setStatus('working')
    setStatus('waiting')
    await vi.advanceTimersByTimeAsync(NOTHING_CAME_BACK_MS + MORE_OUTPUT_SETTLES_MS)
    expect(posts).toEqual([])
    pulled()
    slash.output(TAB, { kind: 'printed', text: 'Compacted (ctrl+o to see full summary)' })
    await vi.advanceTimersByTimeAsync(MORE_OUTPUT_SETTLES_MS)
    expect(posts).toEqual([
      '⌨️ **fix-login** ran /compact:\nCompacted (ctrl+o to see full summary)'
    ])
  })

  it('/clear reports the new conversation id', async () => {
    const { slash, posts, setKey } = setup()
    await slash.typeWhenIdle(child, '/clear', CHANNEL)
    setKey('session-2')
    slash.bound(TAB, 'session-2')
    await vi.advanceTimersByTimeAsync(MORE_OUTPUT_SETTLES_MS)
    expect(posts).toEqual([
      '⌨️ **fix-login** ran /clear:\nIt is a new conversation now, with the id session-2.'
    ])
  })

  it('when nothing comes back, presses Esc once in Claude and then posts what closing printed', async () => {
    const { slash, typed, posts } = setup()
    await slash.typeWhenIdle(child, '/model', CHANNEL)
    await vi.advanceTimersByTimeAsync(NOTHING_CAME_BACK_MS)
    expect(typed.slice(3)).toEqual(['\x1b'])
    slash.output(TAB, { kind: 'printed', text: 'Kept model as Haiku 4.5' })
    await vi.advanceTimersByTimeAsync(MORE_OUTPUT_SETTLES_MS)
    expect(posts[0]).toMatch(
      /^⌨️ \*\*fix-login\*\* ran \/model:\nKept model as Haiku 4\.5\n\nNothing came back/
    )
  })

  it('in Codex, also closes a pager and empties the box, since Esc alone leaves an unknown command typed there', async () => {
    const { slash, typed, posts } = setup({ backendOf: () => 'codex' })
    await slash.typeWhenIdle(child, '/stauts', CHANNEL)
    await vi.advanceTimersByTimeAsync(NOTHING_CAME_BACK_MS)
    expect(typed.slice(4)).toEqual(['\x1b', 'q', '\x05\x15'])
    await vi.advanceTimersByTimeAsync(MORE_OUTPUT_SETTLES_MS)
    expect(posts[0]).toMatch(/only on its screen/)
  })

  it('a local Claude panel that one Esc does not close gets another, but Esc stops once Claude says nothing is open', async () => {
    const open = [false, true, true, false]
    const { slash, typed } = setup({ panelOpen: async () => open.shift() ?? false })
    await slash.typeWhenIdle(child, '/config', CHANNEL)
    await vi.advanceTimersByTimeAsync(NOTHING_CAME_BACK_MS + 2000)
    expect(typed.slice(3)).toEqual(['\x1b', '\x1b'])
  })

  it('no Esc at all when Claude says nothing is open, since a second Esc at an empty prompt opens the rewind menu', async () => {
    const { slash, typed, posts } = setup({ panelOpen: async () => false })
    await slash.typeWhenIdle(child, '/unknown-thing', CHANNEL)
    await vi.advanceTimersByTimeAsync(NOTHING_CAME_BACK_MS + MORE_OUTPUT_SETTLES_MS)
    expect(typed).toEqual(['/unknown-thing', '\x1b', '\r'])
    expect(posts[0]).not.toMatch(/Esc/)
  })

  it('is not typed into a panel left open at the Mac', async () => {
    const { slash, typed } = setup({ panelOpen: async () => true })
    await expect(slash.typeWhenIdle(child, '/compact', CHANNEL)).rejects.toThrow(
      /shows a menu or a panel/
    )
    expect(typed).toEqual([])
  })

  it('does not press Esc while the session is busy with the command', async () => {
    const { slash, typed, setStatus } = setup()
    await slash.typeWhenIdle(child, '/compact', CHANNEL)
    setStatus('working')
    await vi.advanceTimersByTimeAsync(NOTHING_CAME_BACK_MS)
    expect(typed).toEqual(['/compact', '\x1b', '\r'])
  })

  it('in the conductor itself, a reply is not posted again (its replies already reach the channel), nor the text of the command it ran', async () => {
    const { slash, posts, setStatus } = setup()
    await slash.typeWhenIdle({ ...child, conductor: true }, '/review', CHANNEL)
    slash.output(TAB, { kind: 'details', text: 'Review the changes on this branch.' })
    setStatus('working')
    slash.turnEnded(TAB, { said: [], reply: 'All good.', at: Date.now() })
    setStatus('waiting')
    await vi.advanceTimersByTimeAsync(MORE_OUTPUT_SETTLES_MS)
    expect(posts).toEqual([])
  })

  it('waits until the session takes typing, then types', async () => {
    let wake: () => void = () => undefined
    let ok = false
    const { slash, typed } = setup({
      takesTyping: () => ok,
      ready: (_t, ready) =>
        new Promise((resolve) => {
          wake = () => resolve(ready())
        })
    })
    const done = slash.typeWhenIdle(child, '/compact', CHANNEL)
    expect(typed).toEqual([])
    ok = true
    wake()
    await done
    expect(typed).toEqual(['/compact', '\x1b', '\r'])
  })

  it('a session showing a question is refused at once, by every way in, without waiting for its turn', async () => {
    const ready = vi.fn(async () => true)
    const { slash, typed } = setup({ takesTyping: () => false, asking: () => true, ready })
    await expect(slash.typeWhenIdle(child, '/compact', CHANNEL)).rejects.toThrow(
      /waiting for an answer/
    )
    expect(slash.run(child, '/compact', CHANNEL)).toMatch(/waiting for an answer/)
    expect(ready).not.toHaveBeenCalled()
    expect(typed).toEqual([])
  })

  it('a session closed before the result says so and no longer counts as running a command', async () => {
    const { slash, posts } = setup()
    await slash.typeWhenIdle(child, '/compact', CHANNEL)
    slash.closed(TAB)
    expect(posts).toEqual(['⌨️ fix-login closed before /compact printed anything.'])
    expect(slash.running(TAB)).toBe(false)
  })
})
