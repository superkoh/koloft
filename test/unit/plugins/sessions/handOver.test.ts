import { describe, it, expect, vi } from 'vitest'
import { HandOver, type HandOverDeps, type Recipient } from '../../../../src/plugins/sessions/api'

const TAB = 'pty-1'

function setup(more: Partial<HandOverDeps> = {}) {
  const typed: string[] = []
  const quiet: string[] = []
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => (release = resolve))
  const deps: HandOverDeps = {
    backendOf: () => 'codex',
    boundKey: () => 'session-1',
    alive: () => true,
    typable: () => true,
    ready: async (_t, ready) => ready(),
    type: async (_t, keys) => {
      typed.push(keys[0])
      return true
    },
    queue: async (_t, text) => void typed.push(text),
    sendLine: async () => undefined,
    modeOf: () => 'bypass',
    beforeHanding: async () => undefined,
    quiet: {
      handing: (_t, said) => void quiet.push(`+${said}`),
      notHanded: (_t, said) => void quiet.push(`-${said}`)
    },
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
  return { handOver: new HandOver(deps), to, typed, quiet, open: release }
}

describe('handing Koloft’s words to a session', () => {
  it('hands them one after another in the order they came, each with where the owner is, and says each got through', async () => {
    const { handOver, to, typed, open } = setup()
    const first = handOver.tellQuietly(to, 'first')
    const second = handOver.tellQuietly(to, 'second')
    expect(handOver.delivering('r')).toBe(true)
    open()
    expect(await first).toBe(true)
    expect(await second).toBe(true)
    expect(typed).toEqual(['first (The owner is away.)', 'second (The owner is away.)'])
    expect(handOver.delivering('r')).toBe(false)
  })

  it('marks quiet words while they are handed and unmarks them when they fail; plain words are not marked', async () => {
    const { handOver, to, quiet, open } = setup({
      queue: async (_t, text) => {
        if (text.startsWith('fails')) throw new Error('no')
      }
    })
    const told = handOver.tellQuietly(to, 'quiet')
    const plain = new Promise<boolean>((resolve) => handOver.tell(to, 'plain', resolve))
    const fails = handOver.tellQuietly(to, 'fails')
    open()
    expect([await told, await plain, await fails]).toEqual([true, true, false])
    expect(quiet).toEqual(['+quiet', '+fails', '-fails'])
  })

  it('says the session closed before it was ready when it is gone, and did not get ready when it is still there', async () => {
    let alive = false
    const { handOver, to, open } = setup({ ready: async () => false, alive: () => alive })
    const failures: (string | undefined)[] = []
    const settle = (failed?: string): void => void failures.push(failed)
    handOver.hand(to, { clientId: 'a', text: async () => 'x', settle })
    open()
    await vi.waitFor(() => expect(failures).toHaveLength(1))
    alive = true
    handOver.hand(to, { clientId: 'b', text: async () => 'y', settle })
    open()
    await vi.waitFor(() => expect(failures).toHaveLength(2))
    expect(failures).toEqual([
      'Helper closed before it was ready.',
      'Helper did not get ready in time.'
    ])
  })
})
