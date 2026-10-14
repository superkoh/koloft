import { describe, expect, it } from 'vitest'
import { ProgramStatusParser, statusEvent } from '../../src/main/programStatus'
import { museHistory } from '../../src/main/museServe'

const ESC = '\x1b'

describe('ProgramStatusParser (OSC 7501, MUSE§3)', () => {
  it('sees the status question and the states, also when a frame is split across chunks', () => {
    const p = new ProgramStatusParser()
    expect(p.push(`hi${ESC}]7501;?${ESC}\\`)).toEqual({ asked: true, states: [] })
    expect(p.push(`${ESC}]7501;state=wor`)).toEqual({ asked: false, states: [] })
    expect(
      p.push(`king:app=muse\x07${ESC}]7501;state=blocked:app=muse:kind=permission\x07`)
    ).toEqual({
      asked: false,
      states: [{ state: 'working' }, { state: 'blocked', kind: 'permission' }]
    })
  })

  it("ignores a background worker's frame and every other OSC", () => {
    const p = new ProgramStatusParser()
    expect(p.push(`${ESC}]7501;state=working:app=muse:id=w1\x07${ESC}]0;title\x07`)).toEqual({
      asked: false,
      states: []
    })
  })

  it('turns working into a prompt, idle, done and error into a stop, and blocked into a question or approval', () => {
    expect(statusEvent({ state: 'working' })).toEqual({ type: 'prompt' })
    for (const state of ['idle', 'done', 'error'])
      expect(statusEvent({ state })).toEqual({ type: 'stop' })
    expect(statusEvent({ state: 'blocked', kind: 'permission' })).toEqual({
      type: 'notify',
      need: 'approval'
    })
    expect(statusEvent({ state: 'blocked', kind: 'question' })).toEqual({
      type: 'notify',
      need: 'input'
    })
    expect(statusEvent({ state: 'clear' })).toBeUndefined()
  })
})

describe('museHistory (a Muse session read back as turns, MUSE§5)', () => {
  it('pairs each prompt with the replies after it and names the last reply', () => {
    const read = museHistory(
      [
        { kind: 'userMessage', itemId: 'u1', text: 'first', recordedAt: '2026-10-13T23:26:15Z' },
        { kind: 'reasoning', itemId: 'r1', text: 'thinking' },
        {
          kind: 'agentMessage',
          itemId: 'a1',
          text: 'echo: first',
          recordedAt: '2026-10-13T23:26:16Z'
        },
        { kind: 'reminderChild', itemId: 'c1' },
        { kind: 'userMessage', itemId: 'u2', text: 'second', recordedAt: '2026-10-13T23:27:00Z' },
        {
          kind: 'agentMessage',
          itemId: 'a2',
          text: 'echo: second',
          recordedAt: '2026-10-13T23:27:01Z'
        }
      ],
      2
    )
    expect(read.lastReplyId).toBe('a2')
    expect(read.turns.map((t) => [t.said.map((s) => s.text), t.reply])).toEqual([
      [['first'], 'echo: first'],
      [['second'], 'echo: second']
    ])
  })
})
