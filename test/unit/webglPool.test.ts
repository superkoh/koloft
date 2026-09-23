import { describe, it, expect } from 'vitest'
import * as pool from '../../src/renderer/src/webglPool'

describe('webglPool', () => {
  it('keeps at most 12 live contexts: a 13th tab first detaches the least-recently-used holder, and activating an evicted tab re-attaches it', () => {
    const live = new Set<string>()
    const events: string[] = []
    let peak = 0
    const join = (id: string): void =>
      pool.acquireWebgl(
        id,
        () => {
          live.add(id)
          peak = Math.max(peak, live.size)
          events.push(`attach ${id}`)
        },
        () => {
          live.delete(id)
          events.push(`detach ${id}`)
        }
      )

    for (let i = 1; i <= 12; i++) join(`t${i}`)
    expect(live.size).toBe(12)
    pool.touchWebgl('t1')

    events.length = 0
    join('t13')
    expect(events).toEqual(['detach t2', 'attach t13'])
    expect(live.has('t2')).toBe(false)

    events.length = 0
    pool.touchWebgl('t2')
    expect(events).toEqual(['detach t3', 'attach t2'])
    expect(live.size).toBe(12)
    expect(peak).toBe(12)
  })
})
