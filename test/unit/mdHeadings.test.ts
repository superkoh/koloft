import { describe, it, expect } from 'vitest'
import MarkdownIt from 'markdown-it'
import { headingSlug, headingAnchors } from '../../src/renderer/src/mdHeadings'

/** X-9①: the ids an `#anchor` link in a rendered md preview scrolls to. */
describe('headingSlug', () => {
  it('is the GitHub slug an md writer already assumes', () => {
    expect(headingSlug('Section')).toBe('section')
    expect(headingSlug('Open Items / Notes')).toBe('open-items-notes')
    expect(headingSlug('  Trailing space  ')).toBe('trailing-space')
    expect(headingSlug('D5 — 判据(唯一)')).toBe('d5-判据唯一')
  })

  it('has nothing to offer for a heading that is all punctuation', () => {
    expect(headingSlug('###')).toBe('')
    expect(headingSlug('')).toBe('')
  })
})

describe('headingAnchors', () => {
  const md = new MarkdownIt().use(headingAnchors)

  it('gives every heading its slug', () => {
    expect(md.render('# Anchor fixture\n\n## Section\n')).toContain('<h2 id="section">')
  })

  it('keeps repeats reachable instead of minting one id twice', () => {
    const html = md.render('## Notes\n\ntext\n\n## Notes\n')
    expect(html).toContain('<h2 id="notes">')
    expect(html).toContain('<h2 id="notes-1">')
  })

  it('gives a heading with no slug a positional id rather than none at all', () => {
    // never an empty id — and never NO id: the preview's outline lists every heading and
    // locates them by id, so one heading without one shifts every later row by a section
    const html = md.render('# First\n\n## ???\n\n## Third\n')
    expect(html).not.toContain('id=""')
    expect(html).toContain('<h2 id="h-2">')
    expect(html).toContain('<h2 id="third">')
  })
})
