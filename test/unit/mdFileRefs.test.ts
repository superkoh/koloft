import { describe, it, expect } from 'vitest'
import MarkdownIt from 'markdown-it'
import { fileRefs } from '../../src/renderer/src/markdown/fileRefs'

const md = new MarkdownIt().use(fileRefs)
const linkifyingAsThePreviewRuns = new MarkdownIt({ linkify: true }).use(fileRefs)

describe('fileRefs', () => {
  it('links a bare path:line and carries the path and line as data', () => {
    const html = md.render('see sample.ts:12 for details\n')
    expect(html).toContain('class="md-fileref"')
    expect(html).toContain('data-path="sample.ts"')
    expect(html).toContain('data-line="12"')
    expect(html).toContain('>sample.ts:12</a>')
    expect(html).toContain('see ')
    expect(html).toContain(' for details')
  })

  it('links a path:line:col and drops the column (FR-13b)', () => {
    const html = md.render('sample.ts:12:5\n')
    expect(html).toContain('data-line="12"')
    expect(html).toContain('>sample.ts:12:5</a>')
    expect(html).not.toContain('data-col')
  })

  it('links inside inline code, which is where Claude usually writes them', () => {
    const html = md.render('the fix is in `src/main/index.ts:975` today\n')
    expect(html).toContain('<code>')
    expect(html).toContain('class="md-fileref"')
    expect(html).toContain('data-path="src/main/index.ts"')
    expect(html).toContain('data-line="975"')
  })

  it('keeps its hands off a multi-line fenced block (FR-13b)', () => {
    const html = md.render('```ts\n// see src/main/index.ts:975\nconst a = 1\n```\n')
    expect(html).not.toContain('md-fileref')
    expect(html).toContain('src/main/index.ts:975')
  })

  it('ignores a colon+number that belongs to a URL (FR-13b)', () => {
    const html = md.render('see http://localhost:3000/app.ts:12\n')
    expect(html).not.toContain('md-fileref')
    const linkified = linkifyingAsThePreviewRuns.render('see http://localhost:3000/app.ts:12\n')
    expect(linkified).not.toContain('md-fileref')
  })

  it('ignores a full-width colon', () => {
    const html = md.render('see the sample.ts：12 section\n')
    expect(html).not.toContain('md-fileref')
    expect(html).toContain('sample.ts：12')
  })

  it('ignores version numbers and clock times', () => {
    const html = md.render('v0.13.1:12 shipped at 09:30\n')
    expect(html).not.toContain('md-fileref')
    expect(html).toContain('v0.13.1:12')
    expect(html).toContain('09:30')
  })

  it('needs a known code suffix', () => {
    expect(md.render('notes.unknownext:12\n')).not.toContain('md-fileref')
    expect(md.render('README:12\n')).not.toContain('md-fileref')
  })

  it('handles a non-ASCII file name', () => {
    const html = md.render('see the docs/设计说明.md:3 section\n')
    expect(html).toContain('data-path="docs/设计说明.md"')
    expect(html).toContain('data-line="3"')
  })

  it('links only the path when Chinese punctuation, not a space, sets it apart from the sentence around it', () => {
    const colon = md.render('详见：docs/说明.md:3。\n')
    expect(colon).toContain('详见：<a class="md-fileref" data-path="docs/说明.md" data-line="3">')
    expect(colon).toContain('>docs/说明.md:3</a>。')
    const commas = md.render('改动在，docs/说明.md:3，然后提交\n')
    expect(commas).toContain('改动在，<a class="md-fileref" data-path="docs/说明.md"')
    expect(commas).toContain('>docs/说明.md:3</a>，然后提交')
  })

  it('leaves the text of an existing markdown link alone', () => {
    const html = md.render('[sample.ts:12](https://example.com)\n')
    expect(html).not.toContain('md-fileref')
  })

  it('links every reference on a line, not just the first', () => {
    const html = md.render('a.ts:1 and b.py:2\n')
    expect(html).toContain('data-path="a.ts"')
    expect(html).toContain('data-path="b.py"')
  })

  it('emits no href, so a click on a missing file is a no-op rather than a navigation', () => {
    expect(md.render('sample.ts:12\n')).not.toContain('href')
  })
})
