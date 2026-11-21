import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BrowserCdpOp } from '../../../../src/shared/types'

vi.mock('../../../../src/plugins/browser-control/main/cdpRelay', () => ({
  guestDrivenFromAnotherMachine: () => false,
  openForMachine: async () => undefined,
  sessionDrivingGuest: () => null
}))

const { CdpOps } = await import('../../../../src/plugins/browser-control/main/cdpOps')

function ops(answer?: (op: BrowserCdpOp) => object): InstanceType<typeof CdpOps> {
  const made: InstanceType<typeof CdpOps> = new CdpOps({
    push: (_channel, op) => {
      const o = op as BrowserCdpOp
      if (answer) queueMicrotask(() => made.done({ opId: o.opId, ...answer(o) }))
      return true
    },
    sessionForTab: () => null,
    anotherLiveKoloftOwns: () => false,
    cameThroughAForward: () => false
  })
  return made
}

afterEach(() => {
  vi.useRealTimers()
})

describe('what an agent driving a page hears when a tab operation fails, pinned so that moving it changes no character', () => {
  it('the window gives no answer within the budget', async () => {
    vi.useFakeTimers()
    const result = ops().op('mount', 's1', { targetId: 't1' })
    await vi.runAllTimersAsync()
    expect((await result).error).toBe('the Koloft window did not answer')
  })

  it('the window could not mount the tab and gave no reason', async () => {
    await expect(ops(() => ({ ok: false })).relay.mount('s1', 't1')).rejects.toThrow(
      /^could not open that tab$/
    )
  })

  it('the window could not create a tab and gave no reason', async () => {
    await expect(
      ops(() => ({ ok: false })).relay.create('s1', 'https://a.example/')
    ).rejects.toThrow(/^could not create a tab$/)
  })
})
