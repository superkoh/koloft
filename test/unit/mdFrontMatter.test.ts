import { describe, it, expect } from 'vitest'
import MarkdownIt from 'markdown-it'
import { frontMatter } from '../../src/renderer/src/markdown/frontMatter'

/** FR-11: the `---` block a doc opens with is metadata, not an `<hr>` plus a garbled
 *  paragraph. Plugin-level assertions (bare MarkdownIt in, HTML string out) — the pane's
 *  sanitize step needs a DOM and is covered by e2e. */
const md = new MarkdownIt().use(frontMatter)

describe('frontMatter', () => {
  it('turns simple key/value lines into the info card', () => {
    const html = md.render('---\ntitle: 设计稿\nstatus: draft\n---\n\nbody text\n')
    expect(html).toContain('md-frontmatter')
    expect(html).toContain('<span class="md-fm-key">title</span>')
    expect(html).toContain('<span class="md-fm-val">设计稿</span>')
    expect(html).toContain('<span class="md-fm-key">status</span>')
    expect(html).toContain('<span class="md-fm-val">draft</span>')
    expect(html).toContain('<p>body text</p>')
    // the bug this replaces: `---` parsed as a horizontal rule
    expect(html).not.toContain('<hr>')
  })

  it('shows a list value as the text it was written as (FR-11: no deep rendering)', () => {
    const html = md.render('---\ntags: [a, b]\nowner: koh\n---\n\nbody\n')
    expect(html).toContain('<span class="md-fm-val">[a, b]</span>')
    expect(html).toContain('<span class="md-fm-val">koh</span>')
    expect(html).not.toContain('<li>')
  })

  it('falls back to a code block when the YAML is not simple key/value', () => {
    const html = md.render('---\na: [1, 2\n---\n\nbody\n')
    expect(html).not.toContain('md-frontmatter')
    expect(html).toContain('<pre')
    expect(html).toContain('a: [1, 2')
    expect(html).toContain('<p>body</p>')
  })

  it('mints no card for an empty front matter block', () => {
    const html = md.render('---\n---\n\nfirst paragraph\n')
    expect(html).not.toContain('md-frontmatter')
    expect(html.trim().startsWith('<p>first paragraph</p>')).toBe(true)
  })

  it('publishes the pairs on env so the caller gets them without re-parsing', () => {
    const env: Record<string, unknown> = {}
    md.render('---\ntitle: T\n---\n\nbody\n', env)
    expect(env.frontMatter).toEqual({ title: 'T' })
  })

  it('leaves a `---` that never closes to the ordinary rules', () => {
    const html = md.render('---\ntitle: T\n\nbody\n')
    expect(html).not.toContain('md-frontmatter')
    expect(html).toContain('<hr>')
  })

  it('only claims the block when it opens the document', () => {
    const html = md.render('intro\n\n---\ntitle: T\n---\n')
    expect(html).not.toContain('md-frontmatter')
  })

  it('escapes markup inside a value instead of letting it through', () => {
    const html = md.render('---\ntitle: <img src=x onerror=1>\n---\n')
    expect(html).not.toContain('<img')
    expect(html).toContain('&lt;img')
  })
})
