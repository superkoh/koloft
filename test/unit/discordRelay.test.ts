import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { SessionStatus } from '../../src/shared/types'
import type { DiscordMessage } from '../../src/main/discord/link'
import type { CodexQuestion } from '../../src/main/discord/dialog'
import {
  inputNotProbed,
  butlerAsks,
  DiscordRelay,
  OFFLINE_REPLY,
  SHOWS_NO_DIALOG,
  type Destination,
  type RelayDeps
} from '../../src/main/discord/relay'
import { typeKeys } from '../../src/main/typeKeys'
import { waitingForAnswer } from '../../src/shared/slashCommands'

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
  bound: { lastMessageId?: string } = {},
  history: DiscordMessage[] = [],
  more: Partial<RelayDeps> = {},
  dest: Partial<Destination> = {}
) {
  const posts: { text: string; replyTo?: string }[] = []
  const writes: { data: string; at: number }[] = []
  const last: string[] = []
  const reactions: string[] = []
  const asksChanged: string[] = []
  const commands: string[] = []
  const sent: { tab: string; content: string }[] = []
  const conductor: Destination = {
    name: 'Assist',
    liveTab: () => TAB,
    open: async () => TAB,
    typeCommand: async (_t, command) => void commands.push(command),
    seen: (id) => void last.push(id),
    ...dest
  }
  const deps: RelayDeps = {
    link: {
      post: async (_c, text, replyTo) => posts.push({ text, replyTo }),
      card: async (_c, card) => {
        posts.push({ text: [card.header, card.body, card.footer].filter(Boolean).join('\n') })
        return []
      },
      upload: async () => undefined,
      react: async (_c, id, emoji, on) => void reactions.push(`${id} ${on ? '+' : '-'}${emoji}`),
      messages: async (_c, after, limit) =>
        history
          .filter((m) => !after || BigInt(m.id) > BigInt(after))
          .sort((a, b) => (BigInt(b.id) > BigInt(a.id) ? 1 : -1))
          .slice(0, limit)
    },
    download: async () => Buffer.from(''),
    owner: () => OWNER,
    butlerName: () => 'Assist',
    destinationOf: (c) => (c === CHANNEL ? conductor : undefined),
    channels: () => [
      { channelId: CHANNEL, lastMessageId: bound.lastMessageId, seen: (id) => last.push(id) }
    ],
    butlerChannelOf: (t) => (t === TAB ? CHANNEL : undefined),
    withButtons: (_t, view, card) => ({
      ...card,
      buttons: view.choices.map((c, n) => ({ label: c.label, style: c.style, id: `b${n}` }))
    }),
    backendOf: () => 'claude',
    boundKey: () => 'session-1',
    status: (): SessionStatus => 'waiting',
    awaitsInput: () => false,
    turnOver: (t) => ['waiting', 'idle'].includes(deps.status(t) ?? ''),
    alive: () => true,
    ready: async (_t, ready) => {
      while (!ready()) await new Promise((r) => setTimeout(r, 50))
      return true
    },
    asksChanged: (t) => asksChanged.push(t),
    type: (_t, keys) => typeKeys((data) => writes.push({ data, at: Date.now() }), keys),
    queueDrained: () => true,
    queue: async () => undefined,
    sendLine: async (tab, line) =>
      void sent.push({ tab, content: JSON.parse(line).message.content }),
    modeOf: () => 'bypass',
    pendingApproval: () => undefined,
    pendingQuestion: () => undefined,
    answerable: async () => undefined,
    answerInPlace: async () => false,
    regDir: dir,
    attachmentsDir: path.join(dir, 'attachments'),
    ...more
  }
  return {
    relay: new DiscordRelay(deps),
    conductor,
    posts,
    sent,
    bodies: (): string[] => sent.map((s) => s.content.split('\n').slice(1, -2).join('\n')),
    writes,
    last,
    reactions,
    asksChanged,
    commands
  }
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
  asksChanged: string[]
): Promise<fs.FSWatcher | null> {
  const watcher = relay.watchAsks()
  await vi.waitFor(() => {
    drop(hookFile('armed', 'ask'), QUESTION)
    expect(asksChanged).toContain('armed')
  })
  asksChanged.length = 0
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

describe('DiscordRelay: an owner message to a Claude conductor', () => {
  // CC§13 ADR-0028
  it('goes to its message socket as [Discord] text claiming the conductor’s own permission class, with the Discord message id, which Koloft notes as its own; nothing is typed', async () => {
    const { relay, sent, writes, last } = setup({}, [], { modeOf: () => 'prompting' })
    relay.onMessage(message('201', OWNER, 'hello'))
    await vi.waitFor(() => expect(sent).toHaveLength(1))
    expect(sent[0]).toEqual({
      tab: TAB,
      content:
        '<cross-session-message from-mode="prompting">\n[Discord] hello\n(Koloft message koloft-discord-201)\n</cross-session-message>'
    })
    expect(fs.readFileSync(path.join(dir, `${TAB}.discord-ids`), 'utf8')).toBe(
      'koloft-discord-201\n'
    )
    expect(writes).toEqual([])
    await vi.waitFor(() => expect(last).toEqual(['201']))
  })

  it('a message the conductor can take at once gets only ✅; one that has to wait shows ⏳ until it is sent', async () => {
    let status: SessionStatus = 'waiting'
    const { relay, bodies, reactions } = setup({}, [], { status: () => status })
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
    expect(bodies()).toEqual(['[Discord] now', '[Discord] later'])
  })

  it('a stranger’s message is not passed on', async () => {
    const { relay, sent, writes } = setup()
    relay.onMessage(message('202', '556'))
    await new Promise((r) => setTimeout(r, 400))
    expect(sent).toEqual([])
    expect(writes).toEqual([])
  })

  it('a message that starts with a slash is run as a command in the conductor, not handed to its model', async () => {
    const { relay, writes, commands, reactions, last } = setup()
    relay.onMessage(message('205', OWNER, '  /compact keep the plan '))
    await vi.waitFor(() => expect(commands).toEqual(['/compact keep the plan']))
    await vi.waitFor(() => expect(reactions).toEqual(['205 +✅']))
    expect(writes).toEqual([])
    expect(last).toEqual(['205'])
  })

  it('a slash message that comes with a file is an ordinary message', async () => {
    const { relay, bodies, commands } = setup()
    relay.onMessage({
      ...message('206', OWNER, '/look at this'),
      attachments: [{ filename: 'a.txt', size: 1, url: 'http://x/a.txt' }]
    })
    await vi.waitFor(() => expect(bodies()).toHaveLength(1), { timeout: 3000 })
    expect(bodies()[0]).toMatch(/^\[Discord\] \/look at this/)
    expect(commands).toEqual([])
  })

  it('a slash command sent while the conductor is busy shows ⏳ until it is typed, and holds later messages behind it', async () => {
    let status: SessionStatus = 'working'
    const typedCommands: string[] = []
    const { relay, sent, bodies, reactions } = setup(
      {},
      [],
      { status: () => status },
      {
        typeCommand: async (_t, command) => {
          while (status === 'working') await new Promise((r) => setTimeout(r, 50))
          typedCommands.push(command)
        }
      }
    )
    relay.onMessage(message('207', OWNER, '/clear'))
    relay.onMessage(message('209', OWNER, 'then this'))
    await new Promise((r) => setTimeout(r, 400))
    expect(reactions).toEqual(['207 +⏳', '209 +⏳'])
    expect(sent).toEqual([])
    status = 'waiting'
    await vi.waitFor(() => expect(typedCommands).toEqual(['/clear']))
    await vi.waitFor(() => expect(bodies()).toEqual(['[Discord] then this']), { timeout: 3000 })
    expect(reactions.slice(0, 4)).toEqual(['207 +⏳', '209 +⏳', '207 -⏳', '207 +✅'])
  })

  it('a slash command is typed at once into a conductor whose turn is over, though background work it left running still shows it as working', async () => {
    const { relay, commands, reactions } = setup({}, [], {
      status: () => 'working',
      turnOver: () => true
    })
    relay.onMessage(message('210', OWNER, '/compact'))
    await vi.waitFor(() => expect(commands).toEqual(['/compact']))
    await vi.waitFor(() => expect(reactions).toEqual(['210 +✅']))
  })

  // CC§14
  it('a slash command while the conductor shows a question is not taken as the answer', async () => {
    const { relay, posts, asksChanged, commands } = setup()
    const askFile = hookFile(TAB, 'ask')
    const watcher = await watchAsksOnceArmed(relay, asksChanged)
    drop(askFile, QUESTION)
    await vi.waitFor(() => expect(posts).toHaveLength(1))
    relay.onMessage(message('208', OWNER, '/clear'))
    await vi.waitFor(() =>
      expect(posts.map((p) => p.text)).toContain(waitingForAnswer('Assist', '/clear'))
    )
    expect(fs.existsSync(hookFile(TAB, 'answer'))).toBe(false)
    expect(commands).toEqual([])
    watcher?.close()
  })

  // CC§14
  it('answers the conductor’s own open question with the next message, and holds a later message until the question’s file is gone, which alone wakes the wait', async () => {
    const wakes: (() => void)[] = []
    const asksChanged: string[] = []
    const { relay, sent, bodies, posts } = setup({}, [], {
      ready: async (_t, ready) => {
        while (!ready()) await new Promise<void>((wake) => wakes.push(wake))
        return true
      },
      asksChanged: (t) => {
        asksChanged.push(t)
        wakes.splice(0).forEach((wake) => wake())
      }
    })
    const askFile = hookFile(TAB, 'ask')
    const answerFile = hookFile(TAB, 'answer')
    const watcher = await watchAsksOnceArmed(relay, asksChanged)
    drop(askFile, QUESTION)
    await vi.waitFor(() =>
      expect(posts.map((p) => p.text)).toEqual([
        `${butlerAsks('Assist')}\nWhich?\n1. A\n2. B\n-# Reply with a number or your own answer.`
      ])
    )
    relay.onMessage(message('301', OWNER, '2'))
    await vi.waitFor(() => expect(fs.existsSync(answerFile)).toBe(true))
    expect(JSON.parse(fs.readFileSync(answerFile, 'utf8'))).toMatchObject({
      hookSpecificOutput: { decision: { updatedInput: { answers: { 'Which?': 'B' } } } }
    })
    relay.onMessage(message('302', OWNER, 'after the question'))
    await new Promise((r) => setTimeout(r, 600))
    expect(sent).toEqual([])
    fs.rmSync(askFile)
    await vi.waitFor(() => expect(bodies()).toEqual(['[Discord] after the question']), {
      timeout: 3000
    })
    watcher?.close()
  })

  // CC§14
  it('its question held in the terminal, during a turn the owner typed at the Mac, is still posted and is answered from the channel by its keys; once that turn is over, the next message goes to it as usual', async () => {
    let status: SessionStatus = 'approval'
    const { relay, posts, writes, reactions, bodies } = setup({}, [], { status: () => status })
    relay.onAsk(TAB, QUESTION)
    await vi.waitFor(() => expect(posts.map((p) => p.text)[0]).toContain('Which?'))
    relay.onMessage(message('701', OWNER, '2'))
    await vi.waitFor(() => expect(reactions).toContain('701 +✅'))
    expect(writes.map((w) => w.data)).toEqual(['2'])
    relay.onAsk(TAB, { tool_name: 'Bash', tool_input: { command: 'make' } })
    status = 'waiting'
    relay.onMessage(message('702', OWNER, 'next'))
    await vi.waitFor(() => expect(bodies()).toEqual(['[Discord] next']), { timeout: 3000 })
  })

  // CC§14
  it('when the question was answered at the Mac first, the tool’s result lets the waiting hook go with an empty answer, and the next message is not taken as an answer', async () => {
    const { relay, posts, asksChanged } = setup()
    const askFile = hookFile(TAB, 'ask')
    const answerFile = hookFile(TAB, 'answer')
    const watcher = await watchAsksOnceArmed(relay, asksChanged)
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
  it('a local Claude dialog is kept with its full text and posts nothing in Discord, and koloft session answer writes the answer the waiting hook prints', async () => {
    const { relay, posts, asksChanged } = setup()
    const watcher = await watchAsksOnceArmed(relay, asksChanged)
    drop(hookFile(MANAGED, 'ask'), QUESTION)
    await vi.waitFor(() => expect(asksChanged).toEqual([MANAGED]))
    expect(posts).toEqual([])
    expect(relay.dialog(MANAGED)?.text).toBe('Which?\n1. A\n2. B')
    expect(await relay.answerSession(MANAGED, '2')).toBeUndefined()
    expect(JSON.parse(fs.readFileSync(hookFile(MANAGED, 'answer'), 'utf8'))).toMatchObject({
      hookSpecificOutput: { decision: { updatedInput: { answers: { 'Which?': 'B' } } } }
    })
    watcher?.close()
  })

  // CC§14
  it('an approval answered yes is allowed with its input, no is denied with the words', async () => {
    const { relay, asksChanged } = setup()
    const watcher = await watchAsksOnceArmed(relay, asksChanged)
    for (const [reply, decision] of [
      ['yes', { behavior: 'allow', updatedInput: BASH.tool_input }],
      ['no, use make clean', { behavior: 'deny', message: 'no, use make clean' }]
    ] as const) {
      fs.rmSync(hookFile(MANAGED, 'answer'), { force: true })
      drop(hookFile(MANAGED, 'ask'), BASH)
      await vi.waitFor(() => expect(relay.dialog(MANAGED)).toBeDefined())
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
    const { relay, asksChanged } = setup()
    const watcher = await watchAsksOnceArmed(relay, asksChanged)
    drop(hookFile(MANAGED, 'ask', '1'), BASH)
    await vi.waitFor(() => expect(relay.dialog(MANAGED)?.text).toContain('rm -rf build'))
    const next = { tool_name: 'Bash', tool_input: { command: 'make' } }
    drop(hookFile(MANAGED, 'ask', '2'), next)
    await vi.waitFor(() => expect(fs.existsSync(hookFile(MANAGED, 'answer', '1'))).toBe(true))
    expect(JSON.parse(fs.readFileSync(hookFile(MANAGED, 'answer', '1'), 'utf8'))).toEqual({})
    relay.toolDone(MANAGED, { name: 'Bash', input: BASH.tool_input })
    expect(fs.existsSync(hookFile(MANAGED, 'answer', '2'))).toBe(false)
    expect(relay.dialog(MANAGED)?.text).toBe('Bash asks to run:\nmake')
    watcher?.close()
  })

  // CC§14
  it('a Claude session on another machine is answered by keys as soon as its mirrored question arrives, and not once its turn is over', async () => {
    let status: SessionStatus = 'working'
    const { relay, writes, asksChanged } = setup({}, [], { status: () => status })
    const one = {
      tool_name: 'AskUserQuestion',
      tool_input: {
        questions: [{ question: 'Colour?', options: [{ label: 'Red' }, { label: 'Blue' }] }]
      }
    }
    relay.onAsk(MANAGED, one)
    expect(asksChanged).toEqual([MANAGED])
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
      pendingApproval: () => approval,
      pendingQuestion: () => question,
      awaitsInput: () => input
    })
    expect(await relay.answerSession(MANAGED, 'yes')).toBe(SHOWS_NO_DIALOG)
    input = true
    expect(await relay.answerSession(MANAGED, 'yes')).toBe(inputNotProbed('Codex'))
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

  // MUSE§11
  it('a Muse question is pressed its digit then Enter, and an approval y or Esc, each only once Muse is ready to take keys', async () => {
    let approval: { id: string } | undefined
    let question: CodexQuestion | undefined = {
      id: 'u1',
      question: 'Which colour?',
      options: [{ label: 'Red' }, { label: 'Blue' }]
    }
    const ready: string[] = []
    const { relay, writes } = setup({}, [], {
      backendOf: () => 'muse',
      pendingApproval: () => approval,
      pendingQuestion: () => question,
      answerable: async () => void ready.push('ready')
    })
    expect(await relay.answerSession(MANAGED, 'blue')).toBeUndefined()
    expect(writes.map((w) => w.data)).toEqual(['2', '\r'])
    question = undefined
    approval = { id: 'a1' }
    expect(await relay.answerSession(MANAGED, 'maybe')).toBe('a Muse approval takes yes or no.')
    expect(await relay.answerSession(MANAGED, 'yes')).toBeUndefined()
    expect(writes.map((w) => w.data)).toEqual(['2', '\r', 'y'])
    expect(ready).toEqual(['ready', 'ready'])
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
    const { relay, posts, writes } = setup({}, [], {
      backendOf: () => 'codex',
      pendingQuestion: () => question,
      queue: async (_t, text) => void queued.push(text)
    })
    relay.codexAsked(TAB, question!)
    relay.codexAsked(TAB, question!)
    await vi.waitFor(() =>
      expect(posts.map((p) => p.text)).toEqual([
        `${butlerAsks('Assist')}\nWhich colour do you prefer?\n1. Red — Choose red.\n2. Green\n-# Reply with the number or the name of one option.`
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
    await vi.waitFor(() => expect(writes.map((w) => w.data)).toEqual(['2']))

    relay.codexAsked(TAB, question!)
    question = undefined
    relay.onMessage(message('503', OWNER, '1'))
    await vi.waitFor(() => expect(queued).toEqual(['[Discord] 1']))
    expect(writes.map((w) => w.data)).toEqual(['2'])
  })
})

describe('DiscordRelay: Koloft telling a conductor something', () => {
  it('goes the way an owner message does, to its message socket, but is not noted as one of the owner’s Discord messages', async () => {
    const { relay, bodies, conductor } = setup()
    relay.tell(conductor, '[Koloft] Could not deliver to fix-login: it closed.')
    await vi.waitFor(() =>
      expect(bodies()).toEqual(['[Koloft] Could not deliver to fix-login: it closed.'])
    )
    expect(fs.existsSync(path.join(dir, `${TAB}.discord-ids`))).toBe(false)
  })
})
