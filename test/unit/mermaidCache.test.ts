import { describe, it, expect } from 'vitest'
import { hashCode, makeCache } from '../../src/renderer/src/mermaidRender'

/** The cache key for FR-15: "same source ⇒ same rendered svg, don't redraw". */
describe('hashCode', () => {
  it('gives the same source the same key', () => {
    const src = 'flowchart TD\n  A --> B\n'
    expect(hashCode(src)).toBe(hashCode(src))
    expect(hashCode(src)).toBe(hashCode('flowchart TD\n  A --> B\n'))
  })

  it('separates sources that differ by one edit', () => {
    expect(hashCode('flowchart TD\n  A --> B')).not.toBe(hashCode('flowchart TD\n  A --> C'))
    expect(hashCode('graph LR')).not.toBe(hashCode('graph RL'))
    expect(hashCode('ab')).not.toBe(hashCode('ba'))
    expect(hashCode('a')).not.toBe(hashCode('aa'))
  })

  it('handles the empty and the non-ascii source without special-casing at the call site', () => {
    expect(hashCode('')).toBe(hashCode(''))
    expect(hashCode('')).not.toBe(hashCode(' '))
    expect(hashCode('graph A --> graph B')).toBe(hashCode('graph A --> graph B'))
    expect(hashCode('graph A --> graph B')).not.toBe(hashCode('graph A --> graph C'))
  })

  it('is a string a Map can key on, whatever the source length', () => {
    expect(typeof hashCode('x'.repeat(50000))).toBe('string')
    expect(hashCode('x'.repeat(50000)).length).toBeGreaterThan(0)
  })
})

/** §Data Model: `Map<source hash, sanitized svg>`, process-wide, 50 entries LRU. */
describe('makeCache', () => {
  it('returns nothing for a source it has not rendered', () => {
    const c = makeCache()
    expect(c.get('nope')).toBeUndefined()
    expect(c.size).toBe(0)
  })

  it('hands back exactly the svg that was stored', () => {
    const c = makeCache()
    c.set('h1', '<svg id="a"></svg>')
    expect(c.get('h1')).toBe('<svg id="a"></svg>')
    expect(c.size).toBe(1)
  })

  it('holds 50 entries and no more', () => {
    const c = makeCache()
    for (let i = 0; i < 50; i++) c.set(`h${i}`, `svg${i}`)
    expect(c.size).toBe(50)

    // no reads before the 51st: nothing has been promoted, so the oldest stored one goes
    c.set('h50', 'svg50')
    expect(c.size).toBe(50)
    expect(c.get('h50')).toBe('svg50')
    expect(c.get('h0')).toBeUndefined()
    expect(c.get('h1')).toBe('svg1')
    expect(c.get('h49')).toBe('svg49')
  })

  it('re-storing a key updates it in place instead of taking a second slot', () => {
    const c = makeCache()
    c.set('h1', 'first')
    c.set('h1', 'second')
    expect(c.size).toBe(1)
    expect(c.get('h1')).toBe('second')
  })

  it('evicts the least recently *used*, not the least recently stored', () => {
    const c = makeCache()
    for (let i = 0; i < 50; i++) c.set(`h${i}`, `svg${i}`)
    c.get('h0') // a diagram still on screen: reading it keeps it alive
    c.set('h50', 'svg50')

    expect(c.get('h0')).toBe('svg0')
    expect(c.get('h1')).toBeUndefined()
    expect(c.size).toBe(50)
  })

  it('honours a smaller limit when one is given', () => {
    const c = makeCache(2)
    c.set('a', '1')
    c.set('b', '2')
    c.set('c', '3')
    expect(c.size).toBe(2)
    expect(c.get('a')).toBeUndefined()
    expect(c.get('b')).toBe('2')
    expect(c.get('c')).toBe('3')
  })
})
