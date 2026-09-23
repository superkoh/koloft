import { describe, it, expect, vi } from 'vitest'

// NFR-05: one block that fails to render must cost the reader that block, not the document.
// The highlighter is the one dependency in this pipeline that can reject, so it is the one
// worth forcing: a fence carrying BOOM throws, everything else highlights for real.
vi.mock('dompurify', () => ({
  // real DOMPurify needs a DOM; node has none. `addHook` has to exist because the pipeline
  // installs a URL-blocking hook on it, and the sanitize step itself is e2e's to prove.
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
    // the healthy fence beside it is untouched
    expect(doc.html).toContain('<pre class="shiki github-light"')
  })
})
