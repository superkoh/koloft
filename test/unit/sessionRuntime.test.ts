import { afterEach, describe, expect, it } from 'vitest'
import { SessionRuntime } from '../../src/main/sessionRuntime'

const runtime = new SessionRuntime()
const TAB = 'tab-1'

afterEach(() => runtime.forget(TAB))

describe('a session has finished all its work only once its turn ended and nothing it started still runs', () => {
  it('a plain finished turn is finished', async () => {
    runtime.recordTurn(TAB, 'ended')
    expect(await runtime.stillWorking(TAB)).toBe(false)
  })

  it('a session that stopped to ask a question is not finished', async () => {
    runtime.recordTurn(TAB, 'input')
    expect(await runtime.stillWorking(TAB)).toBe(true)
  })

  it('a finished turn with background work still listed is not finished, until the list drains', async () => {
    runtime.recordTurn(TAB, 'ended')
    runtime.setBackground(TAB, [
      { id: 's1', kind: 'server', label: 'npm run dev', state: 'waiting' }
    ])
    expect(await runtime.stillWorking(TAB)).toBe(true)
    runtime.setBackground(TAB, [])
    expect(await runtime.stillWorking(TAB)).toBe(false)
  })

  it('a finished turn with a wakeup scheduled is not finished', async () => {
    runtime.recordTurn(TAB, 'ended')
    runtime.setWakeupPending(TAB, true)
    expect(await runtime.stillWorking(TAB)).toBe(true)
  })
})

describe('a session takes typing once its turn is over, whatever background work it left running', () => {
  it('a turn that ended with background work running still shows working, yet its turn is over and that edge is told', () => {
    const edges: boolean[] = []
    const listen = ({ tabId, over }: { tabId: string; over: boolean }): void => {
      if (tabId === TAB) edges.push(over)
    }
    runtime.on('turn-over', listen)
    runtime.recordTurn(TAB, 'working')
    expect(runtime.turnOver(TAB)).toBe(false)
    runtime.recordTurn(TAB, 'ended', true)
    expect(runtime.statusOf(TAB)).toBe('working')
    expect(runtime.turnOver(TAB)).toBe(true)
    runtime.recordTurn(TAB, 'ended')
    expect(edges).toEqual([true])
    runtime.off('turn-over', listen)
  })
})
