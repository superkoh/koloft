import fs from 'fs'
import os from 'os'
import path from 'path'
import { execFileSync } from 'child_process'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { searchTranscript, searchTranscripts, snippetAround } from '../../src/main/transcriptSearch'

let dir: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'transcript-search-'))
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

const user = (content: unknown, extra: object = {}) =>
  JSON.stringify({ type: 'user', message: { role: 'user', content }, ...extra })
const assistant = (content: unknown) =>
  JSON.stringify({ type: 'assistant', message: { role: 'assistant', content } })

function transcript(name: string, lines: string[]): string {
  const file = path.join(dir, name + '.jsonl')
  fs.writeFileSync(file, lines.join('\n') + '\n')
  return file
}

describe('searchTranscript', () => {
  it('finds words the person typed, as a plain string', async () => {
    const file = transcript('a', [user('please fix the parser crash')])
    expect(await searchTranscript(file, 'parser')).toEqual({
      before: 'please fix the ',
      match: 'parser',
      after: ' crash'
    })
  })

  it('finds words in any text block of a reply, the second one included', async () => {
    const file = transcript('a', [
      assistant([
        { type: 'text', text: 'First I read the file.' },
        { type: 'tool_use', id: 't1', name: 'Read', input: {} },
        { type: 'text', text: 'The tokenizer was the culprit.' }
      ])
    ])
    expect((await searchTranscript(file, 'tokenizer'))?.match).toBe('tokenizer')
  })

  it('ignores tool output, tool calls and Koloft or Claude meta records', async () => {
    const file = transcript('a', [
      user([{ type: 'tool_result', tool_use_id: 't1', content: 'grep found needle here' }]),
      assistant([{ type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'grep needle' } }]),
      user('<local-command-caveat>needle</local-command-caveat>', { isMeta: true }),
      JSON.stringify({ type: 'summary', summary: 'needle summary' })
    ])
    expect(await searchTranscript(file, 'needle')).toBeNull()
  })

  it('matches in any case and keeps the case the text was written in', async () => {
    const file = transcript('a', [user('The Parser Broke')])
    expect((await searchTranscript(file, 'pARSER'))?.match).toBe('Parser')
  })

  it('finds a phrase holding a quote or a backslash, which the transcript stores escaped', async () => {
    const file = transcript('a', [user('it said "ban" followed by C:\\temp')])
    expect((await searchTranscript(file, '"ban" followed'))?.match).toBe('"ban" followed')
    expect((await searchTranscript(file, 'C:\\temp'))?.match).toBe('C:\\temp')
  })

  it('finds non-Latin words', async () => {
    const file = transcript('a', [assistant([{ type: 'text', text: '这个会话已经结束了' }])])
    expect((await searchTranscript(file, '会话'))?.match).toBe('会话')
  })

  it('skips a torn last line, as a mirror copied mid-write has', async () => {
    const file = path.join(dir, 'torn.jsonl')
    fs.writeFileSync(file, user('nothing here') + '\n' + user('needle at the end').slice(0, 40))
    expect(await searchTranscript(file, 'needle')).toBeNull()
  })

  it('answers no hit for a transcript that is gone', async () => {
    expect(await searchTranscript(path.join(dir, 'gone.jsonl'), 'needle')).toBeNull()
  })

  it('stops reading at the first hit, without waiting for the rest of the file', async () => {
    const fifo = path.join(dir, 'endless.jsonl')
    execFileSync('mkfifo', [fifo])
    const searching = searchTranscript(fifo, 'needle')
    const writer = fs.createWriteStream(fifo)
    writer.write(user('the needle comes first') + '\n')
    try {
      expect((await searching)?.match).toBe('needle')
    } finally {
      writer.destroy()
    }
  })
})

describe('snippetAround', () => {
  it('keeps about sixty characters each side on one line, and marks a cut with an ellipsis', () => {
    const text = 'a'.repeat(100) + '\n\nneedle\n' + 'b'.repeat(100)
    const s = snippetAround(text, 'needle')!
    expect(s.before).toBe('…' + 'a'.repeat(58) + ' ')
    expect(s.match).toBe('needle')
    expect(s.after).toBe(' ' + 'b'.repeat(59) + '…')
  })
})

describe('searchTranscripts', () => {
  it('gives one hit per transcript that holds the words, with the first match', async () => {
    const files = [
      { id: 'one', file: transcript('one', [user('needle first'), user('needle second')]) },
      { id: 'two', file: transcript('two', [user('no match')]) },
      { id: 'three', file: transcript('three', [assistant([{ type: 'text', text: 'a needle' }])]) }
    ]
    const found: [string, string][] = []
    await searchTranscripts(files, 'needle', (id, s) => found.push([id, s.after]))
    expect(found.sort()).toEqual([
      ['one', ' first'],
      ['three', '']
    ])
  })
})
