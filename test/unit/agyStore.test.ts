import fs from 'fs'
import os from 'os'
import path from 'path'
import { pathToFileURL } from 'url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  agyTranscript,
  diffCounts,
  lastDiffFor,
  listAgyConversations,
  ownersWords,
  readAgyTurns,
  saidInTranscript,
  TranscriptFollower
} from '../../src/main/agyStore'
import { appendTranscript, ownerTyped, writeSummaries } from './helpers/agyStore'

let gemini: string
let transcript: string

beforeEach(() => {
  gemini = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agy-store-')))
  transcript = agyTranscript(gemini, 'c1')
})

afterEach(() => {
  fs.rmSync(gemini, { recursive: true, force: true })
})

const uris = (...dirs: string[]): string => JSON.stringify(dirs.map((d) => pathToFileURL(d).href))

describe('listAgyConversations (the summaries db, AGY§8)', () => {
  it('lists only top-level conversations of the CLI that have at least one step', async () => {
    writeSummaries(gemini, [
      { conversation_id: 'top', workspace_uris: uris('/w/a') },
      { conversation_id: 'child', workspace_uris: uris('/w/a'), parent_conversation_id: 'top' },
      { conversation_id: 'unused-new', workspace_uris: uris('/w/a'), step_count: 0 },
      { conversation_id: 'desktop', workspace_uris: uris('/w/a'), app_data_dir: 'antigravity' },
      { conversation_id: 'cli', workspace_uris: uris('/w/a'), app_data_dir: 'antigravity-cli' },
      { conversation_id: 'nowhere', workspace_uris: '[]' }
    ])
    const ids = (await listAgyConversations(gemini)).map((e) => e.id).sort()
    expect(ids).toEqual(['cli', 'top'])
  })

  it('leaves out a conversation whose own db was deleted, though agy keeps its row in the summaries db', async () => {
    writeSummaries(gemini, [
      { conversation_id: 'kept', workspace_uris: uris('/w/a') },
      { conversation_id: 'deleted', workspace_uris: uris('/w/a'), dbRemoved: true }
    ])
    expect((await listAgyConversations(gemini)).map((e) => e.id)).toEqual(['kept'])
  })

  it('takes the folder from the first workspace URI, spaces and all, and the title only when agy made one', async () => {
    writeSummaries(gemini, [
      {
        conversation_id: 'a',
        workspace_uris: uris('/w/my proj', '/w/other'),
        title: 'Fix the docs',
        preview: 'fix the docs please'
      },
      { conversation_id: 'b', workspace_uris: uris('/w/b'), preview: 'hello' }
    ])
    const byId = Object.fromEntries((await listAgyConversations(gemini)).map((e) => [e.id, e]))
    expect(byId.a).toMatchObject({ cwd: '/w/my proj', name: 'Fix the docs' })
    expect(byId.b).toMatchObject({ cwd: '/w/b', name: null, preview: 'hello' })
  })

  it('reads the UTC times agy writes with up to 9 decimals, and the year-1 "never" as no time at all', async () => {
    writeSummaries(gemini, [
      {
        conversation_id: 'nine',
        workspace_uris: uris('/w'),
        last_modified_time: '2026-10-16 08:04:16.166182612+00:00'
      },
      {
        conversation_id: 'whole',
        workspace_uris: uris('/w'),
        last_modified_time: '2026-10-16T08:04:16Z'
      },
      {
        conversation_id: 'never',
        workspace_uris: uris('/w'),
        last_modified_time: '0001-01-01 00:00:00+00:00'
      }
    ])
    const byId = Object.fromEntries((await listAgyConversations(gemini)).map((e) => [e.id, e]))
    const at = Date.UTC(2026, 9, 16, 8, 4, 16) / 1000
    expect(byId.nine.updatedAt).toBe(at)
    expect(byId.whole.updatedAt).toBe(at)
    expect(byId.never.updatedAt).toBeUndefined()
  })

  it("dates a conversation's start by when its own db file was made", async () => {
    writeSummaries(gemini, [
      {
        conversation_id: 'a',
        workspace_uris: uris('/w'),
        last_modified_time: '2030-01-01 00:00:00+00:00'
      }
    ])
    const db = path.join(gemini, 'antigravity-cli', 'conversations', 'a.db')
    fs.mkdirSync(path.dirname(db), { recursive: true })
    fs.writeFileSync(db, '')
    const [entry] = await listAgyConversations(gemini)
    const born = fs.statSync(db)
    expect(entry.createdAt).toBe(Math.floor((born.birthtimeMs || born.ctimeMs) / 1000))
    expect(entry.updatedAt).toBe(Date.UTC(2030, 0, 1) / 1000)
  })

  it('lists nothing, and makes no db, in a folder agy never used', async () => {
    expect(await listAgyConversations(gemini)).toEqual([])
    expect(fs.existsSync(path.join(gemini, 'antigravity-cli'))).toBe(false)
  })
})

describe('the transcript (AGY§8)', () => {
  it("reads the owner's words out of agy's USER_REQUEST wrapper, and takes unwrapped text as it is", () => {
    expect(ownersWords(ownerTyped('先别改代码'))).toBe('先别改代码')
    expect(ownersWords('  /compact \n')).toBe('/compact')
  })

  it('pairs each owner message with the replies after it, skipping tool steps, and keeps the last n turns', async () => {
    appendTranscript(transcript, [
      { type: 'USER_INPUT', content: ownerTyped('first'), created_at: '2026-10-16T08:00:00Z' },
      { type: 'PLANNER_RESPONSE', content: '', created_at: '2026-10-16T08:00:01Z' },
      { type: 'GENERIC', content: 'tool output', created_at: '2026-10-16T08:00:02Z' },
      { type: 'PLANNER_RESPONSE', content: 'one', created_at: '2026-10-16T08:00:03Z' },
      { type: 'USER_INPUT', content: ownerTyped('second'), created_at: '2026-10-16T08:01:00Z' },
      { type: 'PLANNER_RESPONSE', content: 'part a', created_at: '2026-10-16T08:01:01Z' },
      { type: 'PLANNER_RESPONSE', content: 'part b', created_at: '2026-10-16T08:01:05Z' }
    ])
    const all = await readAgyTurns(transcript, 10)
    expect(all.map((t) => [t.said.map((s) => s.text), t.reply])).toEqual([
      [['first'], 'one'],
      [['second'], 'part a\n\npart b']
    ])
    expect(all[1].at).toBe(Date.UTC(2026, 9, 16, 8, 1, 5))
    const last = await readAgyTurns(transcript, 1)
    expect(last.map((t) => t.reply)).toEqual(['part a\n\npart b'])
  })

  it('reads a transcript that starts with a reply and no owner message, as a subagent has', async () => {
    appendTranscript(transcript, [
      { type: 'SYSTEM_MESSAGE', content: 'you are a subagent' },
      { type: 'PLANNER_RESPONSE', content: 'done' }
    ])
    expect((await readAgyTurns(transcript, 5)).map((t) => [t.said, t.reply])).toEqual([
      [[], 'done']
    ])
  })

  it('reads a missing transcript as no turns', async () => {
    expect(await readAgyTurns(transcript, 5)).toEqual([])
  })

  it('offers search only what the owner said and agy replied, and stops when told', async () => {
    appendTranscript(transcript, [
      { type: 'USER_INPUT', content: ownerTyped('find the lantern') },
      { type: 'GENERIC', content: 'zebra output' },
      { type: 'PLANNER_RESPONSE', content: 'The lantern is lit.' },
      { type: 'PLANNER_RESPONSE', content: 'never reached' }
    ])
    const seen: string[] = []
    await saidInTranscript(transcript, (text) => {
      seen.push(text)
      return text.includes('lit')
    })
    expect(seen).toEqual(['find the lantern', 'The lantern is lit.'])
  })

  it("counts the added and removed lines of an edit's diff blocks only, not the hunk header or the lines around it", () => {
    const content = [
      'Edited file:///w/a.md',
      '+ not in a block',
      '[diff_block_start]',
      '@@ -1,4 +1,5 @@',
      ' l0',
      '-l1',
      '+X1',
      '+X2',
      ' l3',
      '[diff_block_end]',
      '[diff_block_start]',
      '@@ -9,2 +10,1 @@',
      '-l9',
      ' l10',
      '[diff_block_end]'
    ].join('\n')
    expect(diffCounts(content)).toEqual({ added: 2, removed: 2 })
    expect(diffCounts('Created file file:///w/b.md with requested content.')).toEqual({
      added: 0,
      removed: 0
    })
  })

  it("finds the latest diff agy printed for one file, not another file's", async () => {
    const diff = (file: string, line: string): string =>
      `Edited file://${file}\n[diff_block_start]\n@@ -1 +1 @@\n${line}\n[diff_block_end]`
    appendTranscript(transcript, [
      { type: 'GENERIC', content: diff('/w/a.md', '+old') },
      { type: 'GENERIC', content: diff('/w/a.md', '+new') },
      { type: 'GENERIC', content: diff('/w/b.md', '+other') }
    ])
    expect(await lastDiffFor(transcript, '/w/a.md')).toBe(diff('/w/a.md', '+new'))
    expect(await lastDiffFor(transcript, '/w/c.md')).toBeUndefined()
  })

  it("adds up the tokens of agy's model replies only", async () => {
    appendTranscript(transcript, [
      { type: 'USER_INPUT', content: 'x', input_tokens: 999 },
      { type: 'PLANNER_RESPONSE', input_tokens: 100, output_tokens: 20, cache_read_tokens: 50 },
      { type: 'PLANNER_RESPONSE', input_tokens: 10, output_tokens: 2, cache_read_tokens: 5 }
    ])
    fs.appendFileSync(transcript, 'not json\n')
    expect((await new TranscriptFollower(transcript).catchUp()).tokens).toEqual({
      input: 110,
      output: 22,
      cacheRead: 55
    })
  })

  it('two turns that both ended before one read come out once each, oldest first, and a read that finds nothing new gives no turn', async () => {
    const follower = new TranscriptFollower(transcript)
    appendTranscript(transcript, [
      { type: 'USER_INPUT', content: ownerTyped('the task') },
      { type: 'PLANNER_RESPONSE', content: 'task done' },
      { type: 'USER_INPUT', content: ownerTyped('a quick question') },
      { type: 'PLANNER_RESPONSE', content: 'quick answer' }
    ])
    const replies = (await follower.catchUp()).turns.map((t) => t.reply)
    expect(replies).toEqual(['task done', 'quick answer'])
    expect((await follower.catchUp()).turns).toEqual([])
  })

  it('a turn whose answer has not landed at one read comes out at the read that finds it', async () => {
    const follower = new TranscriptFollower(transcript)
    appendTranscript(transcript, [
      { type: 'USER_INPUT', content: ownerTyped('first') },
      { type: 'PLANNER_RESPONSE', content: 'one' },
      { type: 'USER_INPUT', content: ownerTyped('second') }
    ])
    expect((await follower.catchUp()).turns.map((t) => t.reply)).toEqual(['one', ''])
    appendTranscript(transcript, [{ type: 'PLANNER_RESPONSE', content: 'two' }])
    expect((await follower.catchUp()).turns.map((t) => t.reply)).toEqual(['two'])
  })

  it('the first read of a resumed conversation gives only its last turn, not the turns before it', async () => {
    appendTranscript(transcript, [
      { type: 'USER_INPUT', content: ownerTyped('long ago') },
      { type: 'PLANNER_RESPONSE', content: 'old answer' },
      { type: 'USER_INPUT', content: ownerTyped('just now') },
      { type: 'PLANNER_RESPONSE', content: 'new answer' }
    ])
    const follower = new TranscriptFollower(transcript, true)
    expect((await follower.catchUp()).turns.map((t) => t.reply)).toEqual(['new answer'])
    appendTranscript(transcript, [
      { type: 'USER_INPUT', content: ownerTyped('next') },
      { type: 'PLANNER_RESPONSE', content: 'next answer' },
      { type: 'USER_INPUT', content: ownerTyped('and next') },
      { type: 'PLANNER_RESPONSE', content: 'last answer' }
    ])
    const later = (await follower.catchUp()).turns.map((t) => t.reply)
    expect(later).toEqual(['next answer', 'last answer'])
  })

  it('reading only what each turn added, through a tool output longer than one read piece and a last line whose newline is not written yet, gives the same last turn and tokens as reading the whole transcript once', async () => {
    const longerThanOneReadPiece = 'x'.repeat(300 * 1024)
    const steps = [
      { type: 'USER_INPUT', content: ownerTyped('first') },
      { type: 'PLANNER_RESPONSE', content: 'one', input_tokens: 100, output_tokens: 20 },
      { type: 'USER_INPUT', content: ownerTyped('second') },
      { type: 'GENERIC', content: longerThanOneReadPiece },
      { type: 'PLANNER_RESPONSE', content: 'part a', input_tokens: 10, cache_read_tokens: 5 },
      { type: 'PLANNER_RESPONSE', content: 'part b', input_tokens: 1, output_tokens: 2 }
    ]
    const whole = steps.map((s) => JSON.stringify(s) + '\n').join('')
    const full = path.join(gemini, 'whole.jsonl')
    fs.writeFileSync(full, whole)
    const once = await new TranscriptFollower(full).catchUp()
    expect(once.turns.at(-1)?.reply).toBe('part a\n\npart b')
    expect(once.tokens).toEqual({ input: 111, output: 22, cacheRead: 5 })
    fs.mkdirSync(path.dirname(transcript), { recursive: true })
    const follower = new TranscriptFollower(transcript)
    const longLineMiddle = whole.indexOf(longerThanOneReadPiece) + 200 * 1024
    for (const cut of [37, 120, 121, longLineMiddle, whole.length - 1]) {
      fs.writeFileSync(transcript, whole.slice(0, cut))
      await follower.catchUp()
    }
    const lastAndTokens = ({
      turns,
      tokens
    }: Awaited<ReturnType<TranscriptFollower['catchUp']>>) => [turns.at(-1), tokens]
    expect(lastAndTokens(await follower.catchUp())).toEqual(lastAndTokens(once))
    fs.writeFileSync(transcript, whole)
    expect(lastAndTokens(await follower.catchUp())).toEqual(lastAndTokens(once))
  })

  it('a transcript it cannot read gives no turn and the tokens read before, neither the last turn again nor zero tokens', async () => {
    const follower = new TranscriptFollower(transcript)
    const none = { input: 0, output: 0, cacheRead: 0 }
    expect(await follower.catchUp()).toEqual({ turns: [], tokens: none })
    appendTranscript(transcript, [{ type: 'PLANNER_RESPONSE', content: 'kept', input_tokens: 9 }])
    expect((await follower.catchUp()).turns.map((t) => t.reply)).toEqual(['kept'])
    fs.renameSync(transcript, transcript + '.away')
    expect(await follower.catchUp()).toEqual({ turns: [], tokens: { ...none, input: 9 } })
    fs.renameSync(transcript + '.away', transcript)
    appendTranscript(transcript, [{ type: 'PLANNER_RESPONSE', content: 'more', input_tokens: 1 }])
    expect((await follower.catchUp()).tokens.input).toBe(10)
  })

  it('reads a transcript again from the start once it got shorter, giving only its last turn', async () => {
    const follower = new TranscriptFollower(transcript)
    appendTranscript(transcript, [
      { type: 'USER_INPUT', content: ownerTyped('long gone') },
      { type: 'PLANNER_RESPONSE', content: 'old reply '.repeat(100), input_tokens: 500 }
    ])
    await follower.catchUp()
    fs.writeFileSync(transcript, '')
    appendTranscript(transcript, [
      { type: 'USER_INPUT', content: ownerTyped('kept from before') },
      { type: 'PLANNER_RESPONSE', content: 'rewritten', input_tokens: 3 },
      { type: 'USER_INPUT', content: ownerTyped('latest') },
      { type: 'PLANNER_RESPONSE', content: 'new', input_tokens: 7 }
    ])
    const read = await follower.catchUp()
    expect([read.turns.map((t) => t.reply), read.tokens.input]).toEqual([['new'], 10])
  })
})
