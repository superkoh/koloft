import { describe, expect, it } from 'vitest'
import { ProgramStatusParser, statusEvent } from '../../src/main/programStatus'

const ESC = '\x1b'

describe('ProgramStatusParser (OSC 7501)', () => {
  it('sees the status question and the states, also when a frame is split across chunks', () => {
    const p = new ProgramStatusParser()
    expect(p.push(`hi${ESC}]7501;?${ESC}\\`)).toEqual({ asked: true, states: [] })
    expect(p.push(`${ESC}]7501;state=wor`)).toEqual({ asked: false, states: [] })
    expect(
      p.push(
        `king:app=antigravity\x07${ESC}]7501;state=blocked:app=antigravity:kind=permission\x07`
      )
    ).toEqual({
      asked: false,
      states: [{ state: 'working' }, { state: 'blocked', kind: 'permission' }]
    })
  })

  // AGY§10
  it("reads Antigravity's message, sent as base64 UTF-8, and an empty one as none", () => {
    const p = new ProgramStatusParser()
    const msg = Buffer.from('Approve RunCommand: ls 中文', 'utf8').toString('base64')
    expect(
      p.push(
        `${ESC}]7501;state=blocked:kind=permission:app=antigravity:msg=${msg}\x07${ESC}]7501;state=idle:app=antigravity:msg=\x07`
      )
    ).toEqual({
      asked: false,
      states: [
        { state: 'blocked', kind: 'permission', msg: 'Approve RunCommand: ls 中文' },
        { state: 'idle' }
      ]
    })
  })

  // AGY§10
  it("keeps a turn's end however long the reply its done frame carries and however the frame is split, cutting only the message", () => {
    const reply = 'A long reply. '.repeat(30_000)
    const msg = Buffer.from(reply, 'utf8').toString('base64')
    for (const term of ['\x07', `${ESC}\\`]) {
      const frame = `${ESC}]7501;state=done:app=antigravity:msg=${msg}${term}`
      for (const cuts of [[frame.length - 1], [5000, 300_000, frame.length - 1]]) {
        const p = new ProgramStatusParser()
        const bounds = [0, ...cuts, frame.length]
        const states = bounds
          .slice(1)
          .flatMap((end, k) => p.push(frame.slice(bounds[k], end)).states)
        expect(states.map((s) => s.state)).toEqual(['done'])
        expect(reply.startsWith(states[0].msg?.slice(0, 1000) ?? '-')).toBe(true)
      }
    }
  })

  it("ignores a background worker's frame and every other OSC", () => {
    const p = new ProgramStatusParser()
    expect(p.push(`${ESC}]7501;state=working:app=antigravity:id=w1\x07${ESC}]0;title\x07`)).toEqual(
      {
        asked: false,
        states: []
      }
    )
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
