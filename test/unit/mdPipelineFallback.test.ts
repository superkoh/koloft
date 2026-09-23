import { describe, it, expect, vi } from 'vitest'

vi.mock('dompurify', () => ({
  default: { sanitize: (html: string) => html, addHook: () => {} }
}))
vi.mock('../../src/renderer/src/highlight', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/renderer/src/highlight')>()
  return {
    ...real,
    highlightCodeLight: (code: string, lang: string): Promise<string> =>
      code.includes('BOOM')
        ? Promise.reject(new Error('grammar exploded'))
        : real.highlightCodeLight(code, lang)
  }
})

const katexChunk = vi.hoisted(() => ({ failuresLeft: 1 }))
vi.mock('@vscode/markdown-it-katex', async (importOriginal) => {
  if (katexChunk.failuresLeft > 0) {
    katexChunk.failuresLeft--
    throw new Error('chunk failed to load')
  }
  return importOriginal()
})

const { renderMarkdown } = await import('../../src/renderer/src/markdown/index')

describe('renderMarkdown when the highlighter fails', () => {
  it('drops that fence to plain text and renders the rest of the document', async () => {
    const doc = await renderMarkdown(
      'intro\n\n```ts\nBOOM\n```\n\n```ts\nconst ok = 1\n```\n\nend\n',
      {
        srcPath: '/ws/a.md'
      }
    )
    expect(doc.html).toContain('<p>intro</p>')
    expect(doc.html).toContain('<p>end</p>')
    expect(doc.html).toContain('md-code-plain')
    expect(doc.html).toContain('BOOM')
    expect(doc.html).toContain('<pre class="shiki github-light"')
  })
})

describe('renderMarkdown when the KaTeX chunk fails to load', () => {
  it('keeps the failing document’s text, and the next document with a $ tries the chunk again', async () => {
    const first = await renderMarkdown('cost is $x$ today\n', { srcPath: '/ws/a.md' })
    expect(first.html).toContain('cost is')
    expect(first.html).toContain('today')
    expect(first.html).not.toContain('class="katex')

    const second = await renderMarkdown('cost is $x$ today\n', { srcPath: '/ws/b.md' })
    expect(second.html).toContain('class="katex')
  })
})
