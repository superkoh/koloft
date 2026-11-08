import { describe, it, expect, beforeEach } from 'vitest'
import * as pool from '../../src/renderer/src/webglPool'

const live = new Set<string>()
const events: string[] = []
const enrolled: string[] = []

function enroll(id: string): void {
  pool.enrollWebgl(
    id,
    () => {
      live.add(id)
      events.push(`attach ${id}`)
    },
    () => {
      live.delete(id)
      events.push(`detach ${id}`)
    }
  )
  enrolled.push(id)
}

function show(id: string): void {
  pool.showWebgl(id)
}

beforeEach(() => {
  for (const id of enrolled.splice(0)) pool.releaseWebgl(id)
  live.clear()
  events.length = 0
})

describe('webglPool', () => {
  it('a terminal mounted but never shown holds no context; it takes one the first time it is shown', () => {
    for (let i = 1; i <= 20; i++) enroll(`t${i}`)
    expect(live.size).toBe(0)

    show('t5')
    expect(events).toEqual(['attach t5'])
  })

  it('keeps at most 12 live contexts: a 13th shown terminal detaches the least-recently-shown hidden holder, and showing an evicted one re-attaches it', () => {
    for (let i = 1; i <= 13; i++) enroll(`t${i}`)
    for (let i = 1; i <= 12; i++) {
      show(`t${i}`)
      pool.hideWebgl(`t${i}`)
    }
    expect(live.size).toBe(12)
    show('t1')
    pool.hideWebgl('t1')

    events.length = 0
    show('t13')
    expect(events).toEqual(['detach t2', 'attach t13'])

    events.length = 0
    show('t2')
    expect(events).toEqual(['detach t3', 'attach t2'])
    expect(live.size).toBe(12)
  })

  it('a full pool evicts a hidden holder before a terminal still on screen, however long ago that one was shown', () => {
    for (let i = 1; i <= 13; i++) enroll(`t${i}`)
    show('t1')
    for (let i = 2; i <= 12; i++) {
      show(`t${i}`)
      pool.hideWebgl(`t${i}`)
    }

    events.length = 0
    show('t13')
    expect(events).toEqual(['detach t2', 'attach t13'])
    expect(live.has('t1')).toBe(true)
  })
})
