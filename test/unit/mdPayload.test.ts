import { describe, it, expect, vi } from 'vitest'
import { renderMarkdown } from '../../src/renderer/src/markdown/index'

vi.mock('dompurify', () => ({
  // real DOMPurify needs a DOM; node has none. `addHook` has to exist because the pipeline
  // installs a URL-blocking hook on it, and the sanitize step itself is e2e's to prove.
  default: { sanitize: (html: string) => html, addHook: () => {} }
}))

/**
 * Regression guard for the integration bug that cost every flowchart its source: DOMPurify's
 * SAFE_FOR_XML (default on) DELETES an attribute whose value contains `-->` or `]>`, and a
 * mermaid arrow is exactly that. HTML-escaping does not help — the rule inspects the DECODED
 * value — so the payload is percent-encoded instead. These tests fail the moment a plain
 * (escaped-only) attribute comes back.
 */
const render = (text: string) => renderMarkdown(text, { srcPath: '/ws/a.md' })

/** every `data-code="…"` value in the rendered HTML, still encoded */
function payloads(html: string): string[] {
  return [...html.matchAll(/data-code="([^"]*)"/g)].map((m) => m[1])
}

describe('data-code payloads survive DOMPurify SAFE_FOR_XML', () => {
  it('carries a mermaid arrow without ever spelling --> in the attribute', async () => {
    const doc = await render('```mermaid\nflowchart TD\n  A --> B\n```\n')
    const [value] = payloads(doc.html)
    expect(value).not.toContain('-->')
    expect(value).not.toContain(']>')
    expect(decodeURIComponent(value)).toBe('flowchart TD\n  A --> B')
  })

  it('carries a code fence holding an HTML comment', async () => {
    const doc = await render('```html\n<!-- note -->\n<p>x</p>\n```\n')
    const [value] = payloads(doc.html)
    expect(value).not.toContain('-->')
    expect(decodeURIComponent(value)).toBe('<!-- note -->\n<p>x</p>')
  })

  it('carries quotes, newlines and non-ASCII unchanged', async () => {
    const src = 'flowchart TD\n  A["甲 & 乙"] --> B[\'丙\']'
    const doc = await render('```mermaid\n' + src + '\n```\n')
    const [value] = payloads(doc.html)
    expect(value).not.toContain('"')
    expect(decodeURIComponent(value)).toBe(src)
  })

  it('leaves a diagram bracket-arrow out of the attribute too', async () => {
    const src = 'graph LR\n  a[x]> --- b'
    const doc = await render('```mermaid\n' + src + '\n```\n')
    const [value] = payloads(doc.html)
    expect(value).not.toContain(']>')
    // and the source still comes back whole — plain HTML escaping would also pass the
    // line above (`]&gt;` contains no `]>`) while losing the attribute to the sanitizer
    expect(decodeURIComponent(value)).toBe(src)
  })
})
