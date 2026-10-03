import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { ConductorBinding, SessionStatus } from '../../src/shared/types'
import type { DiscordMessage } from '../../src/main/discord/link'
import { DiscordRelay, OFFLINE_REPLY, type RelayDeps } from '../../src/main/discord/relay'

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

function setup(over: Partial<ConductorBinding> = {}, history: DiscordMessage[] = []) {
  const bound: ConductorBinding = {
    id: 'b1',
    scope: 'global',
    backend: 'claude',
    channel: { guildId: '1', channelId: CHANNEL },
    sessionIds: [],
    touched: [],
    ...over
  }
  const posts: { text: string; replyTo?: string }[] = []
  const writes: { data: string; at: number }[] = []
  const last: string[] = []
  const deps: RelayDeps = {
    link: {
      post: async (_c, text, replyTo) => posts.push({ text, replyTo }),
      upload: async () => undefined,
      react: async () => undefined,
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
    alive: () => true,
    write: (_t, data) => writes.push({ data, at: Date.now() }),
    queue: async () => undefined,
    codexApproval: () => undefined,
    regDir: dir,
    attachmentsDir: path.join(dir, 'attachments')
  }
  return { relay: new DiscordRelay(deps), posts, writes, last }
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

  it('a stranger’s message is not typed', async () => {
    const { relay, writes } = setup()
    relay.onMessage(message('202', '556'))
    await new Promise((r) => setTimeout(r, 400))
    expect(writes).toEqual([])
  })

  // CC§14
  it('answers the conductor’s own open question with the next message, and holds a later message until the question is gone', async () => {
    const { relay, writes, posts } = setup()
    const askFile = path.join(dir, `${TAB}.ask.json`)
    const answerFile = path.join(dir, `${TAB}.answer.json`)
    const watcher = relay.watchAsks()
    fs.writeFileSync(
      askFile,
      JSON.stringify({
        tool_name: 'AskUserQuestion',
        tool_input: {
          questions: [{ question: 'Which?', options: [{ label: 'A' }, { label: 'B' }] }]
        }
      })
    )
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
  it('when the question was answered at the Mac first, an empty answer lets the waiting hook go, and the next message is not taken as an answer', async () => {
    const { relay, posts } = setup()
    const askFile = path.join(dir, `${TAB}.ask.json`)
    const answerFile = path.join(dir, `${TAB}.answer.json`)
    const watcher = relay.watchAsks()
    fs.writeFileSync(
      askFile,
      JSON.stringify({ tool_name: 'ExitPlanMode', tool_input: { plan: 'p' } })
    )
    await vi.waitFor(() => expect(posts).toHaveLength(1))
    relay.dialogAnswered(TAB)
    expect(JSON.parse(fs.readFileSync(answerFile, 'utf8'))).toEqual({})
    fs.rmSync(answerFile)
    relay.onMessage(message('401', OWNER, 'yes'))
    await new Promise((r) => setTimeout(r, 100))
    expect(fs.existsSync(answerFile)).toBe(false)
    fs.rmSync(askFile)
    watcher?.close()
  })
})
