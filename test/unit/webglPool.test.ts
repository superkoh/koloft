import { describe, it, expect, beforeEach } from 'vitest'
import { enrollWebgl, hideWebgl, releaseWebgl, showWebgl } from '../../src/renderer/src/webglPool'

const live = new Set<string>()
const events: string[] = []
const enrolled: string[] = []
let peak = 0

function enroll(id: string): void {
  enrollWebgl(
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
  enrolled.push(id)
}

function glance(id: string): void {
  showWebgl(id)
  hideWebgl(id)
}

beforeEach(() => {
  for (const id of enrolled.splice(0)) releaseWebgl(id)
  live.clear()
  events.length = 0
  peak = 0
})

describe('webglPool', () => {
  it('a terminal mounted but never shown holds no context; it takes one the first time it is shown', () => {
    for (let i = 1; i <= 20; i++) enroll(`t${i}`)
    expect(live.size).toBe(0)

    showWebgl('t5')
    expect(events).toEqual(['attach t5'])
  })

  it('keeps at most 12 live contexts: a 13th shown terminal detaches the hidden holder least recently on screen, and showing an evicted one re-attaches it', () => {
    for (let i = 1; i <= 13; i++) enroll(`t${i}`)
    for (let i = 1; i <= 12; i++) glance(`t${i}`)
    expect(live.size).toBe(12)
    glance('t1')

    events.length = 0
    showWebgl('t13')
    expect(events).toEqual(['detach t2', 'attach t13'])

    events.length = 0
    showWebgl('t2')
    expect(events).toEqual(['detach t3', 'attach t2'])
    expect(live.size).toBe(12)
    expect(peak).toBe(12)
  })

  it('a full pool evicts a hidden holder before a terminal still on screen, however long ago that one was shown', () => {
    for (let i = 1; i <= 13; i++) enroll(`t${i}`)
    showWebgl('t1')
    for (let i = 2; i <= 12; i++) glance(`t${i}`)

    events.length = 0
    showWebgl('t13')
    expect(events).toEqual(['detach t2', 'attach t13'])
    expect(live.has('t1')).toBe(true)
  })

  it('the terminal the user just left is the last hidden one to lose its context, even if it was first shown long ago', () => {
    for (let i = 1; i <= 13; i++) enroll(`t${i}`)
    showWebgl('t1')
    for (let i = 2; i <= 12; i++) glance(`t${i}`)
    hideWebgl('t1')

    events.length = 0
    showWebgl('t13')
    expect(events).toEqual(['detach t2', 'attach t13'])
  })

  it('a terminal whose WebGL fails to attach and releases itself does not keep a slot', () => {
    for (let i = 1; i <= 12; i++) {
      enroll(`t${i}`)
      glance(`t${i}`)
    }
    enrollWebgl(
      'broken',
      () => releaseWebgl('broken'),
      () => {}
    )
    showWebgl('broken')

    enroll('t13')
    events.length = 0
    showWebgl('t13')
    expect(events).toEqual(['attach t13'])
  })
})
