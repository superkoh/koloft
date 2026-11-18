import { describe, it, expect } from 'vitest'
import { HandOver, type HandOverDeps, type Recipient } from '../../../../src/plugins/sessions/api'

const TAB = 'pty-1'

function setup(more: Partial<HandOverDeps> = {}) {
  const typed: string[] = []
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => (release = resolve))
  const deps: HandOverDeps = {
    backendOf: () => 'codex',
    boundKey: () => 'session-1',
    alive: () => true,
    typable: () => true,
    ready: async (_t, ready) => ready(),
    type: async () => true,
    queue: async (_t, text) => void typed.push(text),
    sendLine: async () => undefined,
    modeOf: () => 'bypass',
    ...more
  }
  const to: Recipient = {
    key: 'r',
    name: 'Helper',
    liveTab: () => TAB,
    open: async () => {
      await gate
      return TAB
    },
    ownerIsWhere: () => '(The owner is away.)'
  }
  return { handOver: new HandOver(deps), to, typed, open: release }
}

describe('handing Koloft’s words to a session', () => {
  it('hands them one after another in the order they came, each with where the owner is, and says each got through', async () => {
    const { handOver, to, typed, open } = setup()
    const first = handOver.tell(to, 'first')
    const second = handOver.tell(to, 'second')
    expect(handOver.delivering('r')).toBe(true)
    open()
    expect([await first, await second]).toEqual([true, true])
    expect(typed).toEqual(['first (The owner is away.)', 'second (The owner is away.)'])
    expect(handOver.delivering('r')).toBe(false)
  })

  it('marks words as they are handed with the marks they came with, and takes the mark back when they could not be handed', async () => {
    const { handOver, to, open } = setup({
      queue: async (_t, text) => {
        if (text.startsWith('fails')) throw new Error('no')
      }
    })
    const marks: string[] = []
    const marked = {
      handing: (_t: string, said: string) => void marks.push(`+${said}`),
      notHanded: (_t: string, said: string) => void marks.push(`-${said}`)
    }
    const told = handOver.tell(to, 'marked', marked)
    const plain = handOver.tell(to, 'plain')
    const fails = handOver.tell(to, 'fails', marked)
    open()
    expect([await told, await plain, await fails]).toEqual([true, true, false])
    expect(marks).toEqual(['+marked', '+fails', '-fails'])
  })
})
