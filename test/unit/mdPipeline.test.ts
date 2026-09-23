import { describe, it, expect, vi } from 'vitest'
import { renderMarkdown } from '../../src/renderer/src/markdown/index'

// Node has no document, so DOMPurify's factory hands back an unsupported stub that has no
// `sanitize` at all. Sanitizing is e2e's to prove (it needs a real DOM); passing it through
// here is what lets the rest of the pipeline — the part this module owns — be asserted.
vi.mock('dompurify', () => ({
  // real DOMPurify needs a DOM; node has none. `addHook` has to exist because the pipeline
  // installs a URL-blocking hook on it, and the sanitize step itself is e2e's to prove.
  default: { sanitize: (html: string) => html, addHook: () => {} }
}))

/**
 * The whole pipeline, markdown in / HTML out (NFR-06). Node has no DOM, so DOMPurify is
 * inert here and the sanitize step itself is an e2e concern; everything before it is
 * asserted directly. Colour assertions live in e2e too — shiki's palette is not this
 * module's contract.
 */
const SRC = '/ws/docs/design.md'
const render = (text: string) => renderMarkdown(text, { srcPath: SRC })

/** the first `data-code` payload, decoded — it rides percent-encoded because DOMPurify
 *  strips any attribute containing `-->` (mdPayload.test.ts pins the reason) */
function payload(html: string): string {
  const m = /data-code="([^"]*)"/.exec(html)
  return m ? decodeURIComponent(m[1]) : ''
}

describe('renderMarkdown', () => {
  it('returns the heading outline with the ids the anchors use', async () => {
    const doc = await render('# 概述\n\ntext\n\n## 设计\n\n### 细节\n')
    expect(doc.headings).toEqual([
      { id: '概述', text: '概述', level: 1 },
      { id: '设计', text: '设计', level: 2 },
      { id: '细节', text: '细节', level: 3 }
    ])
    expect(doc.html).toContain('<h2 id="设计">')
  })

  it('has no outline for a document without headings', async () => {
    const doc = await render('just a paragraph\n')
    expect(doc.headings).toEqual([])
  })

  it('wraps a fence in the code-block chrome with the raw text on the copy button', async () => {
    const doc = await render('```python\nprint(1)\nprint(2)\n```\n')
    expect(doc.html).toContain('md-code')
    expect(doc.html).toContain('<span class="md-code-lang">python</span>')
    expect(doc.html).toContain('md-code-copy')
    expect(payload(doc.html)).toBe('print(1)\nprint(2)')
    // FR-05: the preview's own theme, not the code view's dark one
    expect(doc.html).toContain('<pre class="shiki github-light"')
  })

  it('encodes the copy payload so code can never break out of the attribute', async () => {
    const doc = await render('```html\n<img src="x">\n```\n')
    // percent-encoded, not merely escaped: DOMPurify deletes attributes containing `-->`
    // or `]>` outright, so nothing may reach the attribute in raw form (see mdPayload.test)
    expect(doc.html).toContain('data-code="%3Cimg%20src%3D%22x%22%3E"')
    expect(payload(doc.html)).toBe('<img src="x">')
  })

  it('keeps chrome on an empty fence and on an unknown language', async () => {
    const empty = await render('```bash\n```\n\nafter\n')
    expect(empty.html).toContain('<span class="md-code-lang">bash</span>')
    expect(empty.html).toContain('md-code-copy')
    expect(empty.html).toContain('<p>after</p>')
    const elixir = await render('```elixir\nIO.puts "hi"\n```\n')
    expect(elixir.html).toContain('md-code-copy')
    expect(elixir.html).toContain('IO.puts')
  })

  it('skips highlighting past 2000 lines but keeps every line (NFR-04)', async () => {
    const lines = (n: number): string =>
      Array.from({ length: n }, (_, i) => `const v${i} = ${i}`).join('\n')
    const over = await render('```ts\n' + lines(2001) + '\n```\n')
    expect(over.html).toContain('md-code-plain')
    expect(over.html).toContain('const v0 = 0')
    expect(over.html).toContain('const v2000 = 2000')
    const atLimit = await render('```ts\n' + lines(2000) + '\n```\n')
    expect(atLimit.html).not.toContain('md-code-plain')
    // 60s, not 30: this is the one case here that does real work (shiki highlights 2000
    // lines for the at-limit half), and it timed out once on a machine that was busy
    // running the app at the same time. The assertions are about output, not speed.
  }, 60000)

  it('leaves a mermaid fence as a placeholder and reports it as a diagram', async () => {
    const doc = await render('```mermaid\nflowchart TD\n  A --> B\n```\n')
    expect(doc.diagrams).toEqual([{ id: 'mmd-0', code: 'flowchart TD\n  A --> B' }])
    expect(doc.html).toContain('class="mmd"')
    expect(payload(doc.html)).toBe('flowchart TD\n  A --> B')
    expect(doc.html).not.toContain('md-code-copy')
  })

  it('gives repeated identical diagrams distinct ids', async () => {
    const one = '```mermaid\nflowchart TD\n  A --> B\n```\n'
    const doc = await render(one + '\n' + one)
    expect(doc.diagrams.map((d) => d.id)).toEqual(['mmd-0', 'mmd-1'])
    expect(doc.diagrams[0].code).toBe(doc.diagrams[1].code)
  })

  it('leaves an unsupported diagram language as an ordinary code block (FR-16)', async () => {
    const doc = await render('```plantuml\n@startuml\n@enduml\n```\n')
    expect(doc.diagrams).toEqual([])
    expect(doc.html).toContain('md-code-copy')
    expect(doc.html).toContain('@startuml')
  })

  it('renders inline and block formulas without leaving the delimiters behind', async () => {
    const inline = await render('when $E = mc^2$ holds\n')
    expect(inline.html).toContain('katex')
    expect(inline.html).not.toContain('$E = mc^2$')
    const block = await render('$$\\frac{a}{b}$$\n')
    expect(block.html).toContain('katex')
    expect(block.html).not.toContain('$$')
  })

  it('does not emit the MathML annotation, whose raw LaTeX would survive sanitizing as text', async () => {
    const doc = await render('$$\\frac{a}{b}$$\n')
    expect(doc.html).not.toContain('<annotation')
    expect(doc.html).not.toContain('katex-mathml')
  })

  it('leaves dollar amounts and shell variables as written (Edge Cases #6)', async () => {
    const doc = await render('Spent $100 this month, next month budget $200.\n\n`$PATH`\n')
    expect(doc.html).toContain('$100')
    expect(doc.html).toContain('$200')
    expect(doc.html).toContain('$PATH')
    expect(doc.html).toContain('Spent')
    expect(doc.html).toContain('next month budget')
  })

  it('keeps a broken formula visible instead of swallowing it', async () => {
    const doc = await render('$$\\frac{a}{$$\n\nafter\n')
    expect(doc.html).toContain('frac')
    expect(doc.html).toContain('<p>after</p>')
  })

  it('renders footnotes with both jump directions (FR-10)', async () => {
    const doc = await render('body[^1]\n\n[^1]: the note\n')
    expect(doc.html).toContain('footnote-ref')
    expect(doc.html).toContain('href="#fn1"')
    expect(doc.html).toContain('footnote-backref')
    expect(doc.html).toContain('the note')
  })

  it('returns front matter as data and as a card, and null when there is none', async () => {
    const doc = await render('---\ntitle: Design draft\n---\n\nbody\n')
    expect(doc.frontMatter).toEqual({ title: 'Design draft' })
    expect(doc.html).toContain('md-frontmatter')
    expect((await render('body\n')).frontMatter).toBeNull()
    expect((await render('---\n---\n\nbody\n')).frontMatter).toBeNull()
  })

  it('wraps a table so the overflow happens inside it (FR-17)', async () => {
    const doc = await render('| a | b |\n| --- | --- |\n| 1 | 2 |\n')
    expect(doc.html).toContain('<div class="md-table-wrap"><table>')
    expect(doc.html).toContain('</table></div>')
  })

  it('carries the alert, task and file-reference plugins', async () => {
    const doc = await render('> [!NOTE]\n> heads up\n\n- [x] done\n\nsee sample.ts:12\n')
    expect(doc.html).toContain('md-alert-note')
    expect(doc.html).toContain('md-task')
    expect(doc.html).toContain('data-path="sample.ts"')
  })

  it('rewrites images through the local protocol', async () => {
    const doc = await render('![pic](./pic.png)\n')
    expect(doc.html).toContain('koloft-file://localhost/ws/docs/pic.png')
  })

  it('shows bidi control characters instead of letting them reorder the code (BB-N12)', async () => {
    const doc = await render('```ts\nconst a = 1 // \u202Eevil\n```\n')
    expect(doc.html).toContain('md-bidi')
    expect(doc.html).toContain('U+202E')
    // the copy payload keeps the file's bytes
    expect(payload(doc.html)).toContain('\u202Eevil')
  })

  it('renders an empty document without throwing', async () => {
    const doc = await render('')
    expect(doc.headings).toEqual([])
    expect(doc.diagrams).toEqual([])
    expect(doc.frontMatter).toBeNull()
  })
})
