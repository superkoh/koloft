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
