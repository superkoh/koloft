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

  it('only the two hidden terminals looked at last keep a context: leaving a third hands the oldest one back, and showing that one again re-attaches it', () => {
    for (let i = 1; i <= 4; i++) enroll(`t${i}`)
    glance('t1')
    glance('t2')
    expect(live.size).toBe(2)

    events.length = 0
    glance('t3')
    expect(events).toEqual(['attach t3', 'detach t1'])

    events.length = 0
    glance('t1')
    expect(events).toEqual(['attach t1', 'detach t2'])
    expect(peak).toBe(3)
  })

  it('terminals on screen together all keep their context, and a hidden one is handed back only when a third joins the hidden ones', () => {
    for (let i = 1; i <= 6; i++) enroll(`t${i}`)
    for (let i = 1; i <= 6; i++) showWebgl(`t${i}`)
    expect(live.size).toBe(6)

    events.length = 0
    hideWebgl('t1')
    hideWebgl('t2')
    expect(events).toEqual([])
    hideWebgl('t3')
    expect(events).toEqual(['detach t1'])
  })

  it('the terminal the user just left keeps its context, even if it was first shown long ago', () => {
    for (let i = 1; i <= 3; i++) enroll(`t${i}`)
    showWebgl('t1')
    glance('t2')
    glance('t3')

    events.length = 0
    hideWebgl('t1')
    expect(events).toEqual(['detach t2'])
    expect(live.has('t1')).toBe(true)
  })

  it('keeps at most 12 live contexts: a 13th terminal on screen takes the context of a hidden holder before that of one still on screen', () => {
    for (let i = 1; i <= 14; i++) enroll(`t${i}`)
    for (let i = 1; i <= 11; i++) showWebgl(`t${i}`)
    glance('t12')

    events.length = 0
    showWebgl('t13')
    expect(events).toEqual(['detach t12', 'attach t13'])

    events.length = 0
    showWebgl('t14')
    expect(events).toEqual(['detach t1', 'attach t14'])
    expect(peak).toBe(12)
  })

  it('a terminal whose WebGL fails to attach and releases itself does not keep a slot', () => {
    for (let i = 1; i <= 11; i++) {
      enroll(`t${i}`)
      showWebgl(`t${i}`)
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
