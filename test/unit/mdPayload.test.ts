import { describe, it, expect, vi } from 'vitest'
import { renderMarkdown } from '../../src/renderer/src/markdown/index'

vi.mock('dompurify', () => ({
  default: { sanitize: (html: string) => html, addHook: () => {} }
}))

const render = (text: string) => renderMarkdown(text, { srcPath: '/ws/a.md' })

function payloads(html: string): string[] {
  return [...html.matchAll(/data-code="([^"]*)"/g)].map((m) => m[1])
}

// PLATFORM§26
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
    expect(decodeURIComponent(value)).toBe(src)
  })
})
