import { describe, it, expect, vi } from 'vitest'
import { renderBlocks } from '../../src/renderer/src/markdown/render'
import '../../src/renderer/src/markdown/index'

vi.mock('dompurify', () => ({
  default: () => ({
    sanitize: (html: string) => html,
    addHook: (name: string, fn: (node: unknown) => void) => {
      purifyHooks[name] = fn
    }
  })
}))

const purifyHooks = vi.hoisted(() => ({}) as Record<string, (node: unknown) => void>)

function sanitizedAttrs(attrs: Record<string, string>): Record<string, string> {
  const el = {
    getAttribute: (k: string): string | null => attrs[k] ?? null,
    setAttribute: (k: string, v: string): void => {
      attrs[k] = v
    },
    removeAttribute: (k: string): void => {
      delete attrs[k]
    }
  }
  purifyHooks.afterSanitizeAttributes(el)
  return attrs
}

const SRC = '/ws/docs/design.md'
const render = async (text: string) => {
  const doc = await renderBlocks(text, { srcPath: SRC, token: 'T' })
  return { ...doc, html: doc.blocks.join('') }
}
const SHIKI_2000_LINES_TIMEOUT_MS_ON_A_BUSY_MACHINE = 60_000

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

  it('names an outline entry by the heading’s words, leaving its inline HTML tags out', async () => {
    const doc = await render('# Press <kbd>Ctrl</kbd> twice\n')
    expect(doc.headings.map((h) => h.text)).toEqual(['Press Ctrl twice'])
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
    expect(doc.html).toContain('<pre class="shiki github-light"')
  })

  it('highlights each fence on its own even when language and code run together the same way', async () => {
    const doc = await render('```js\non{a}\n```\n\n```json\n{a}\n```\n')
    const shown = [...doc.html.matchAll(/<pre[^>]*>([\s\S]*?)<\/pre>/g)].map((m) =>
      m[1].replace(/<[^>]*>/g, '')
    )
    expect(shown).toEqual(['on{a}', '{a}'])
  })

  it('encodes the copy payload so code can never break out of the attribute', async () => {
    const doc = await render('```html\n<img src="x">\n```\n')
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

  it(
    'skips highlighting past 2000 lines but keeps every line (NFR-04)',
    async () => {
      const lines = (n: number): string =>
        Array.from({ length: n }, (_, i) => `const v${i} = ${i}`).join('\n')
      const over = await render('```ts\n' + lines(2001) + '\n```\n')
      expect(over.html).toContain('md-code-plain')
      expect(over.html).toContain('const v0 = 0')
      expect(over.html).toContain('const v2000 = 2000')
      const atLimit = await render('```ts\n' + lines(2000) + '\n```\n')
      expect(atLimit.html).not.toContain('md-code-plain')
    },
    SHIKI_2000_LINES_TIMEOUT_MS_ON_A_BUSY_MACHINE
  )

  it('leaves a mermaid fence as a placeholder carrying its source', async () => {
    const doc = await render('```mermaid\nflowchart TD\n  A --> B\n```\n')
    expect(doc.html).toContain('class="mmd"')
    expect(payload(doc.html)).toBe('flowchart TD\n  A --> B')
    expect(doc.html).not.toContain('md-code-copy')
  })

  it('renders a diagram the same wherever it sits, so adding one above leaves the ones below untouched on a reload', async () => {
    const one = '```mermaid\nflowchart TD\n  A --> B\n```\n'
    const before = await render('text\n\n' + one)
    const after = await render(one + '\ntext\n\n' + one)
    expect(after.blocks.at(-1)).toBe(before.blocks.at(-1))
  })

  it('leaves an unsupported diagram language as an ordinary code block (FR-16)', async () => {
    const doc = await render('```plantuml\n@startuml\n@enduml\n```\n')
    expect(doc.html).not.toContain('class="mmd"')
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

  it('shows front matter as a card', async () => {
    const doc = await render('---\ntitle: Design draft\n---\n\nbody\n')
    expect(doc.html).toContain('md-frontmatter')
    expect(doc.html).toContain('Design draft')
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
    expect(payload(doc.html)).toContain('\u202Eevil')
  })

  it('keeps an untrusted formula like \\rule{999999em}{999999em} within the maxSize cap, so it cannot blow up the layout', async () => {
    const doc = await render('$\\rule{999999em}{999999em}$\n')
    expect(doc.html).toMatch(/border-top-width:[\d.]+em/)
    expect(doc.html).not.toContain('999999em')
    const sizes = [...doc.html.matchAll(/([\d.]+)em/g)].map((m) => Number(m[1]))
    expect(Math.max(...sizes)).toBeLessThanOrEqual(10)
  })

  it('moves a remote img src to data-blocked, so raw HTML cannot make the renderer fetch off the machine', async () => {
    await render('<img src="https://example.com/a.png">\n')
    expect(sanitizedAttrs({ src: 'https://example.com/a.png' })).toEqual({
      'data-blocked': 'https://example.com/a.png'
    })
    expect(sanitizedAttrs({ src: '//example.com/a.png' })).toEqual({
      'data-blocked': '//example.com/a.png'
    })
    expect(sanitizedAttrs({ src: 'koloft-file://localhost/ws/a.png' })).toEqual({
      src: 'koloft-file://localhost/ws/a.png'
    })
    expect(sanitizedAttrs({ src: 'data:image/png;base64,AA==' })).toEqual({
      src: 'data:image/png;base64,AA=='
    })
  })

  it('drops a style that names an off-machine address (background:url, image-set) but keeps colours and local urls', async () => {
    await render('<span style="color:#f00">x</span>\n')
    expect(sanitizedAttrs({ style: 'background:url(https://example.com/b.png)' })).toEqual({})
    expect(sanitizedAttrs({ style: "background:url('//example.com/b.png')" })).toEqual({})
    expect(
      sanitizedAttrs({ style: "background-image:image-set('https://example.com/c.png' 1x)" })
    ).toEqual({})
    expect(sanitizedAttrs({ style: 'color:#24292e' })).toEqual({ style: 'color:#24292e' })
    expect(sanitizedAttrs({ style: 'background:url(koloft-file://localhost/ws/bg.png)' })).toEqual({
      style: 'background:url(koloft-file://localhost/ws/bg.png)'
    })
  })

  it('hands back each top-level block on its own, so a big document can be put on screen a piece at a time', async () => {
    const doc = await render('# a\n\npara\n\n- x\n- y\n\n> quote\n')
    expect(doc.blocks).toEqual([
      '<h1 id="a">a</h1>\n',
      '<p>para</p>\n',
      '<ul>\n<li data-ln="0,1">x</li>\n<li data-ln="1,3">y</li>\n</ul>\n',
      '<blockquote>\n<p data-ln="0,1">quote</p>\n</blockquote>\n'
    ])
    expect(doc.lines).toEqual([
      [0, 1],
      [2, 3],
      [4, 7],
      [7, 8]
    ])
  })

  it('names the lines inside a block from the block’s own first line, so a line added above leaves the block’s HTML as it was and only its start moves', async () => {
    const body = 'intro\n\n- one\n- two\n\n```js\nx\n```\n'
    const before = await render(body)
    const after = await render('added\n\n' + body)
    expect(after.blocks.slice(1)).toEqual(before.blocks)
    expect(after.lines.slice(1)).toEqual(before.lines.map((l) => [l![0] + 2, l![1] + 2]))
  })

  it('marks a code block inside a list with its lines, and the footnote list, whose opening carries no line, takes the lines of its notes', async () => {
    const doc = await render('- item\n\n  ```sh\n  ls\n  ```\n')
    expect(doc.blocks[0]).toContain('<div class="md-code" data-ln="2,5">')
    const notes = await render('a[^1]\n\n[^1]: one\n')
    expect(notes.lines.at(-1)).toEqual([2, 3])
  })

  it('keeps raw HTML that opens in one block and closes in a later one inside a single block, so sanitizing it alone cannot cut the element in two', async () => {
    const doc = await render('intro\n\n<details>\n\n**inside**\n\n</details>\n\nafter\n')
    expect(doc.blocks).toHaveLength(3)
    expect(doc.blocks[1]).toContain('<details>')
    expect(doc.blocks[1]).toContain('<strong>inside</strong>')
    expect(doc.blocks[1]).toContain('</details>')
    expect(doc.blocks[2]).toBe('<p>after</p>\n')
  })

  it.each([
    ['closes every tag', '<p align="center"><img src="logo.png"></p>'],
    ['leaves out an end tag HTML lets go unwritten', '<p align="center"><img src="logo.png">'],
    ['has a stray inline tag', 'Made with <b>care'],
    ['has a self-closing svg', '<svg width="8" height="8"><circle r="4"/></svg>'],
    ['has a tag only inside a comment', '<!-- <div> -->']
  ])('still splits a README whose raw HTML at the top %s', async (_case, top) => {
    const body = Array.from({ length: 50 }, (_, i) => `para ${i}`).join('\n\n')
    const doc = await render(`${top}\n\n${body}\n\n<!-- footer -->\n<br>\n`)
    expect(doc.blocks.length).toBeGreaterThan(50)
  })

  it('keeps the whole footnote list in one block however many footnotes there are', async () => {
    const doc = await render('a[^1] b[^2] c^[inline]\n\n[^1]: one\n[^2]: two\n')
    const notes = doc.blocks.filter((b) => b.includes('footnote-item'))
    expect(notes).toHaveLength(1)
    expect(notes[0]).toMatch(/^<hr class="footnotes-sep">[\s\S]*<\/section>\n$/)
  })

  it('renders an empty document without throwing', async () => {
    const doc = await render('')
    expect(doc.headings).toEqual([])
    expect(doc.blocks).toEqual([])
  })
})
