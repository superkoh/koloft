import { describe, expect, it } from 'vitest'
import type { StatusEdge } from '../../src/main/sessionRuntime'

async function runtimeWithIdleMs(idleMs: string) {
  process.env.KOLOFT_IDLE_MS = idleMs
  const { vi } = await import('vitest')
  vi.resetModules()
  const { SessionRuntime } = await import('../../src/main/sessionRuntime')
  const runtime = new SessionRuntime()
  const edges: Omit<StatusEdge, 'tabId'>[] = []
  runtime.on('status', ({ prev, next }: StatusEdge) => edges.push({ prev, next }))
  return { runtime, edges }
}

describe('a turn that goes from ended to asking with no working step between', () => {
  it('ended -> input emits waiting -> approval, and input -> ended emits approval -> waiting', async () => {
    const { runtime, edges } = await runtimeWithIdleMs('240000')
    runtime.recordTurn('t', 'working')
    runtime.recordTurn('t', 'ended')
    runtime.recordTurn('t', 'input')
    runtime.recordTurn('t', 'ended')
    console.log('edges (idle 4 min):', JSON.stringify(edges))
    expect(edges).toEqual([
      { prev: undefined, next: 'working' },
      { prev: 'working', next: 'waiting' },
      { prev: 'waiting', next: 'approval' },
      { prev: 'approval', next: 'waiting' }
    ])
    runtime.forget('t')
  })

  it('a long-idle session that then asks emits idle -> approval', async () => {
    const { runtime, edges } = await runtimeWithIdleMs('0')
    runtime.recordTurn('t', 'ended')
    await new Promise((r) => setTimeout(r, 20))
    runtime.recordTurn('t', 'input')
    console.log('edges (idle 0 ms):', JSON.stringify(edges))
    expect(edges).toEqual([
      { prev: undefined, next: 'waiting' },
      { prev: 'waiting', next: 'idle' },
      { prev: 'idle', next: 'approval' }
    ])
    runtime.forget('t')
  })

  it('a turn held by background work (status working) that then asks emits working -> approval', async () => {
    const { runtime, edges } = await runtimeWithIdleMs('240000')
    runtime.recordTurn('t', 'ended', true)
    runtime.recordTurn('t', 'input')
    console.log('edges (held by background):', JSON.stringify(edges))
    expect(edges).toEqual([
      { prev: undefined, next: 'working' },
      { prev: 'working', next: 'approval' }
    ])
    runtime.forget('t')
  })
})
