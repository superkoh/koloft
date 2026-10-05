import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { ConductorBinding, SessionStatus } from '../../src/shared/types'
import type { DiscordMessage } from '../../src/main/discord/link'
import type { CodexQuestion } from '../../src/main/discord/dialog'
import {
  CODEX_INPUT_NOT_PROBED,
  DiscordRelay,
  OFFLINE_REPLY,
  SHOWS_NO_DIALOG,
  type RelayDeps
} from '../../src/main/discord/relay'

const OWNER = '555'
const CHANNEL = '222'
const TAB = 'pty-x-1'

let dir: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-relay-'))
})
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

function message(id: string, authorId = OWNER, content = `said ${id}`): DiscordMessage {
  return { id, channelId: CHANNEL, authorId, bot: false, content, attachments: [] }
}

function setup(
  over: Partial<ConductorBinding> = {},
  history: DiscordMessage[] = [],
  more: Partial<RelayDeps> = {}
) {
  const bound: ConductorBinding = {
    id: 'b1',
    scope: 'global',
    backend: 'claude',
    channel: { guildId: '1', channelId: CHANNEL, name: 'koloft' },
    sessionIds: [],
    touched: [],
    ...over
  }
  const posts: { text: string; replyTo?: string }[] = []
  const writes: { data: string; at: number }[] = []
  const last: string[] = []
  const waiting: string[] = []
  const reactions: string[] = []
  const asksChanged: string[] = []
  const deps: RelayDeps = {
    link: {
      post: async (_c, text, replyTo) => posts.push({ text, replyTo }),
      upload: async () => undefined,
      react: async (_c, id, emoji, on) => void reactions.push(`${id} ${on ? '+' : '-'}${emoji}`),
      messages: async (_c, after, limit) =>
        history
          .filter((m) => !after || BigInt(m.id) > BigInt(after))
          .sort((a, b) => (BigInt(b.id) > BigInt(a.id) ? 1 : -1))
          .slice(0, limit)
    },
    download: async () => Buffer.from(''),
    conductors: {
      owner: () => OWNER,
      bindings: () => [bound],
      bindingOfChannel: (c) => (c === CHANNEL ? bound : undefined),
      bindingOfTab: (t) => (t === TAB ? bound : undefined),
      liveTab: () => TAB,
      open: async () => ({ ok: true, tabId: TAB }),
      setLastMessage: (_b, id) => {
        last.push(id)
      }
    },
    backendOf: () => 'claude',
    boundKey: () => 'session-1',
    status: (): SessionStatus => 'waiting',
    awaitsInput: () => false,
    waiting: (t) => waiting.push(t),
    alive: () => true,
    ready: async (_t, ready) => {
      while (!ready()) await new Promise((r) => setTimeout(r, 50))
      return true
    },
    asksChanged: (t) => asksChanged.push(t),
    write: (_t, data) => writes.push({ data, at: Date.now() }),
    queue: async () => undefined,
    codexApproval: () => undefined,
    codexQuestion: () => undefined,
    regDir: dir,
    attachmentsDir: path.join(dir, 'attachments'),
    ...more
  }
  return { relay: new DiscordRelay(deps), posts, writes, last, waiting, reactions, asksChanged }
}

const HOOK = '4242'
const hookFile = (tab: string, suffix: string, hook = HOOK): string =>
  path.join(dir, `${tab}.${hook}.${suffix}.json`)
const drop = (file: string, payload: unknown): void =>
  fs.writeFileSync(file, JSON.stringify(payload))
const QUESTION = {
  tool_name: 'AskUserQuestion',
  tool_input: { questions: [{ question: 'Which?', options: [{ label: 'A' }, { label: 'B' }] }] }
}

async function watchAsksOnceArmed(
  relay: DiscordRelay,
  waiting: string[]
): Promise<fs.FSWatcher | null> {
  const watcher = relay.watchAsks()
  await vi.waitFor(() => {
    drop(hookFile('armed', 'ask'), QUESTION)
    expect(waiting).toContain('armed')
  })
  waiting.length = 0
  return watcher
}

describe('DiscordRelay: offline catch-up', () => {
  it('answers each owner message sent while Koloft was away once, delivers none, and moves past the newest', async () => {
    const { relay, posts, writes, last } = setup({ lastMessageId: '100' }, [
      message('99'),
      message('101'),
      message('102', '556'),
      message('103')
    ])
    await relay.catchUp()
    await vi.waitFor(() => expect(posts).toHaveLength(2))
    expect(posts).toEqual([
      { text: OFFLINE_REPLY, replyTo: '101' },
      { text: OFFLINE_REPLY, replyTo: '103' }
    ])
    expect(writes).toEqual([])
    expect(last).toEqual(['103'])
  })

  it('on the first run it only remembers the newest message, and answers nothing', async () => {
    const { relay, posts, last } = setup({}, [message('7'), message('9')])
    await relay.catchUp()
    expect(posts).toEqual([])
    expect(last).toEqual(['9'])
  })

  it('skips a message that already arrived live during this run', async () => {
    const { relay, posts } = setup({ lastMessageId: '100' }, [message('101')])
    relay.onMessage(message('101'))
    await relay.catchUp()
    await new Promise((r) => setTimeout(r, 50))
    expect(posts.filter((p) => p.text === OFFLINE_REPLY)).toEqual([])
  })
})

describe('DiscordRelay: typing an owner message into a Claude conductor', () => {
  it('types the text, then Enter in a separate write at least 300 ms later', async () => {
    const { relay, writes, last } = setup()
    relay.onMessage(message('201', OWNER, 'hello'))
    await vi.waitFor(() => expect(writes).toHaveLength(2), { timeout: 3000 })
    expect(writes[0].data).toBe('[Discord] hello')
    expect(writes[1].data).toBe('\r')
    expect(writes[1].at - writes[0].at).toBeGreaterThanOrEqual(290)
    await vi.waitFor(() => expect(last).toEqual(['201']))
  })

  it('a message the conductor can take at once gets only ✅; one that has to wait shows ⏳ until it is typed', async () => {
    let status: SessionStatus = 'waiting'
    const { relay, writes, reactions } = setup({}, [], { status: () => status })
    relay.onMessage(message('203', OWNER, 'now'))
    await vi.waitFor(() => expect(reactions).toEqual(['203 +✅']), { timeout: 3000 })
    status = 'approval'
    relay.onMessage(message('204', OWNER, 'later'))
    await new Promise((r) => setTimeout(r, 400))
    expect(reactions).toEqual(['203 +✅', '204 +⏳'])
    status = 'waiting'
    await vi.waitFor(
      () => expect(reactions).toEqual(['203 +✅', '204 +⏳', '204 -⏳', '204 +✅']),
      { timeout: 3000 }
    )
    expect(writes.map((w) => w.data)).toEqual(['[Discord] now', '\r', '[Discord] later', '\r'])
  })

  it('a stranger’s message is not typed', async () => {
    const { relay, writes } = setup()
    relay.onMessage(message('202', '556'))
    await new Promise((r) => setTimeout(r, 400))
    expect(writes).toEqual([])
  })

  // CC§14
  it('answers the conductor’s own open question with the next message, and holds a later message until the question’s file is gone, which alone wakes the wait', async () => {
    const wakes: (() => void)[] = []
    const { relay, writes, posts, waiting } = setup({}, [], {
      ready: async (_t, ready) => {
        while (!ready()) await new Promise<void>((wake) => wakes.push(wake))
        return true
      },
      asksChanged: () => wakes.splice(0).forEach((wake) => wake())
    })
    const askFile = hookFile(TAB, 'ask')
    const answerFile = hookFile(TAB, 'answer')
    const watcher = await watchAsksOnceArmed(relay, waiting)
    drop(askFile, QUESTION)
    await vi.waitFor(() =>
      expect(posts.map((p) => p.text)).toEqual([
        '❓ Which?\n1. A\n2. B\n\nReply with a number or your own answer.'
      ])
    )
    relay.onMessage(message('301', OWNER, '2'))
    await vi.waitFor(() => expect(fs.existsSync(answerFile)).toBe(true))
    expect(JSON.parse(fs.readFileSync(answerFile, 'utf8'))).toMatchObject({
      hookSpecificOutput: { decision: { updatedInput: { answers: { 'Which?': 'B' } } } }
    })
    relay.onMessage(message('302', OWNER, 'after the question'))
    await new Promise((r) => setTimeout(r, 600))
    expect(writes).toEqual([])
    fs.rmSync(askFile)
    await vi.waitFor(
      () => expect(writes.map((w) => w.data)).toEqual(['[Discord] after the question', '\r']),
      { timeout: 3000 }
    )
    watcher?.close()
  })

  // CC§14
  it('when the question was answered at the Mac first, the tool’s result lets the waiting hook go with an empty answer, and the next message is not taken as an answer', async () => {
    const { relay, posts, waiting } = setup()
    const askFile = hookFile(TAB, 'ask')
    const answerFile = hookFile(TAB, 'answer')
    const watcher = await watchAsksOnceArmed(relay, waiting)
    drop(askFile, { tool_name: 'ExitPlanMode', tool_input: { plan: 'p', planFilePath: '/p' } })
    await vi.waitFor(() => expect(posts).toHaveLength(1))
    relay.toolDone(TAB, { name: 'ExitPlanMode', input: {} })
    expect(JSON.parse(fs.readFileSync(answerFile, 'utf8'))).toEqual({})
    fs.rmSync(answerFile)
    relay.onMessage(message('401', OWNER, 'yes'))
    await new Promise((r) => setTimeout(r, 100))
    expect(fs.existsSync(answerFile)).toBe(false)
    fs.rmSync(askFile)
    watcher?.close()
  })
})

describe('DiscordRelay: a dialog of a session a conductor looks after', () => {
  const MANAGED = 'pty-x-2'
  const BASH = { tool_name: 'Bash', tool_input: { command: 'rm -rf build', description: 'Clean' } }

  // CC§14
  it('a local Claude dialog is announced as waiting with its full text, and koloft session answer writes the answer the waiting hook prints', async () => {
    const { relay, posts, waiting } = setup()
    const watcher = await watchAsksOnceArmed(relay, waiting)
    drop(hookFile(MANAGED, 'ask'), QUESTION)
    await vi.waitFor(() => expect(waiting).toEqual([MANAGED]))
    expect(posts).toEqual([])
    expect(relay.dialogDetail(MANAGED)).toBe('Which?\n1. A\n2. B')
    expect(await relay.answerSession(MANAGED, '2')).toBeUndefined()
    expect(JSON.parse(fs.readFileSync(hookFile(MANAGED, 'answer'), 'utf8'))).toMatchObject({
      hookSpecificOutput: { decision: { updatedInput: { answers: { 'Which?': 'B' } } } }
    })
    watcher?.close()
  })

  // CC§14
  it('an approval answered yes is allowed with its input, no is denied with the words', async () => {
    const { relay, waiting } = setup()
    const watcher = await watchAsksOnceArmed(relay, waiting)
    for (const [reply, decision] of [
      ['yes', { behavior: 'allow', updatedInput: BASH.tool_input }],
      ['no, use make clean', { behavior: 'deny', message: 'no, use make clean' }]
    ] as const) {
      fs.rmSync(hookFile(MANAGED, 'answer'), { force: true })
      drop(hookFile(MANAGED, 'ask'), BASH)
      await vi.waitFor(() => expect(relay.dialogDetail(MANAGED)).toBeDefined())
      expect(await relay.answerSession(MANAGED, reply)).toBeUndefined()
      expect(
        JSON.parse(fs.readFileSync(hookFile(MANAGED, 'answer'), 'utf8')).hookSpecificOutput.decision
      ).toEqual(decision)
      fs.rmSync(hookFile(MANAGED, 'ask'))
    }
    expect(await relay.answerSession(MANAGED, 'yes')).toBe(SHOWS_NO_DIALOG)
    watcher?.close()
  })

  // CC§14
  it('a newer dialog on the same tab lets the older hook, answered at the Mac, go; a result of another call leaves the open one alone', async () => {
    const { relay, waiting } = setup()
    const watcher = await watchAsksOnceArmed(relay, waiting)
    drop(hookFile(MANAGED, 'ask', '1'), BASH)
    await vi.waitFor(() => expect(relay.dialogDetail(MANAGED)).toContain('rm -rf build'))
    const next = { tool_name: 'Bash', tool_input: { command: 'make' } }
    drop(hookFile(MANAGED, 'ask', '2'), next)
    await vi.waitFor(() => expect(fs.existsSync(hookFile(MANAGED, 'answer', '1'))).toBe(true))
    expect(JSON.parse(fs.readFileSync(hookFile(MANAGED, 'answer', '1'), 'utf8'))).toEqual({})
    relay.toolDone(MANAGED, { name: 'Bash', input: BASH.tool_input })
    expect(fs.existsSync(hookFile(MANAGED, 'answer', '2'))).toBe(false)
    expect(relay.dialogDetail(MANAGED)).toBe('Bash asks to run:\nmake')
    watcher?.close()
  })

  // CC§14
  it('a Claude session on another machine is answered by keys as soon as its mirrored question arrives, and not once its turn is over', async () => {
    let status: SessionStatus = 'working'
    const { relay, writes, waiting } = setup({}, [], { status: () => status })
    const one = {
      tool_name: 'AskUserQuestion',
      tool_input: {
        questions: [{ question: 'Colour?', options: [{ label: 'Red' }, { label: 'Blue' }] }]
      }
    }
    relay.onAsk(MANAGED, one)
    expect(waiting).toEqual([MANAGED])
    expect(await relay.answerSession(MANAGED, 'Purple')).toBeUndefined()
    expect(writes.map((w) => w.data)).toEqual(['3', 'Purple', '\r'])
    expect(writes[2].at - writes[1].at).toBeGreaterThanOrEqual(290)
    expect(await relay.answerSession(MANAGED, '1')).toBe(SHOWS_NO_DIALOG)

    relay.onAsk(MANAGED, one)
    status = 'approval'
    expect(await relay.answerSession(MANAGED, '2')).toBeUndefined()
    expect(writes.at(-1)?.data).toBe('2')

    relay.onAsk(MANAGED, one)
    status = 'waiting'
    expect(await relay.answerSession(MANAGED, '2')).toBe(SHOWS_NO_DIALOG)
    status = 'working'

    relay.onAsk(MANAGED, BASH)
    expect(await relay.answerSession(MANAGED, 'maybe later')).toContain('only answer yes or no')
    relay.toolDone(MANAGED, { name: 'Bash', input: BASH.tool_input })
    expect(await relay.answerSession(MANAGED, 'yes')).toBe(SHOWS_NO_DIALOG)
  })

  // CODEX§3 CODEX§20
  it('a Codex approval is pressed y or Esc only while it is open; a one-question list is pressed the digit of the option named by number or label; any other question is refused as not probed', async () => {
    let approval: { id: number } | undefined
    let question: CodexQuestion | undefined
    let input = false
    const { relay, writes } = setup({}, [], {
      backendOf: () => 'codex',
      codexApproval: () => approval,
      codexQuestion: () => question,
      awaitsInput: () => input
    })
    expect(await relay.answerSession(MANAGED, 'yes')).toBe(SHOWS_NO_DIALOG)
    input = true
    expect(await relay.answerSession(MANAGED, 'yes')).toBe(CODEX_INPUT_NOT_PROBED)
    question = {
      id: 0,
      question: 'Which colour?',
      options: [{ label: 'Red' }, { label: 'Green' }]
    }
    expect(await relay.answerSession(MANAGED, '3')).toContain('one option')
    expect(await relay.answerSession(MANAGED, 'blue')).toContain('one option')
    expect(await relay.answerSession(MANAGED, '2')).toBeUndefined()
    expect(await relay.answerSession(MANAGED, ' green ')).toBeUndefined()
    approval = { id: 7 }
    expect(await relay.answerSession(MANAGED, '2')).toContain('yes or no')
    expect(await relay.answerSession(MANAGED, 'yes')).toBeUndefined()
    expect(await relay.answerSession(MANAGED, 'no')).toBeUndefined()
    expect(writes.map((w) => w.data)).toEqual(['2', '2', 'y', '\x1b'])
  })
})

describe('DiscordRelay: a Codex conductor’s own question', () => {
  // CODEX§20
  it('is posted once with its options; the owner’s number or option name presses that digit while it is open, any other reply is asked again, and once it closes a message goes to the conductor as usual', async () => {
    let question: CodexQuestion | undefined = {
      id: 'q1',
      question: 'Which colour do you prefer?',
      options: [{ label: 'Red', description: 'Choose red.' }, { label: 'Green' }]
    }
    const queued: string[] = []
    const { relay, posts, writes } = setup({ backend: 'codex' }, [], {
      backendOf: () => 'codex',
      codexQuestion: () => question,
      queue: async (_t, text) => void queued.push(text)
    })
    relay.codexAsked(TAB, question!)
    relay.codexAsked(TAB, question!)
    await vi.waitFor(() =>
      expect(posts.map((p) => p.text)).toEqual([
        '❓ Which colour do you prefer?\n1. Red — Choose red.\n2. Green\n\nReply with the number or the name of one option.'
      ])
    )

    relay.onMessage(message('501', OWNER, '3'))
    await vi.waitFor(() =>
      expect(posts.at(-1)).toEqual({
        text: 'Reply with the number or the name of one option.',
        replyTo: '501'
      })
    )
    relay.onMessage(message('502', OWNER, 'green'))
    expect(writes.map((w) => w.data)).toEqual(['2'])

    relay.codexAsked(TAB, question!)
    question = undefined
    relay.onMessage(message('503', OWNER, '1'))
    await vi.waitFor(() => expect(queued).toEqual(['[Discord] 1']))
    expect(writes.map((w) => w.data)).toEqual(['2'])
  })
})

describe('DiscordRelay: Koloft telling a conductor something', () => {
  it('goes the way an owner message does: typed, then Enter', async () => {
    const { relay, writes } = setup()
    relay.tell('b1', '[Koloft] Could not deliver to fix-login: it closed.')
    await vi.waitFor(() =>
      expect(writes.map((w) => w.data)).toEqual([
        '[Koloft] Could not deliver to fix-login: it closed.',
        '\r'
      ])
    )
  })
})
