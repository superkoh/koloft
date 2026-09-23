import { describe, it, expect } from 'vitest'
import MarkdownIt from 'markdown-it'
import { alerts } from '../../src/renderer/src/markdown/alerts'

const md = new MarkdownIt().use(alerts)

describe('alerts', () => {
  it('renders each of the five kinds as its own card', () => {
    for (const kind of ['NOTE', 'TIP', 'IMPORTANT', 'WARNING', 'CAUTION']) {
      const html = md.render(`> [!${kind}]\n> body of ${kind}\n`)
      expect(html).toContain(`md-alert md-alert-${kind.toLowerCase()}`)
      expect(html).toContain('md-alert-icon')
      expect(html).toContain('md-alert-title')
      expect(html).toContain(kind)
      expect(html).toContain(`body of ${kind}`)
      expect(html).not.toContain('<blockquote>')
      expect(html).not.toContain(`[!${kind}]`)
    }
  })

  it('is case-insensitive about the kind, like GitHub', () => {
    const html = md.render('> [!note]\n> body\n')
    expect(html).toContain('md-alert md-alert-note')
    expect(html).not.toContain('[!note]')
  })

  it('leaves an ordinary blockquote alone', () => {
    const html = md.render('> just a quote\n')
    expect(html).toContain('<blockquote>')
    expect(html).not.toContain('md-alert')
  })

  it('leaves an unknown kind alone rather than inventing a card', () => {
    const html = md.render('> [!HINT]\n> body\n')
    expect(html).toContain('<blockquote>')
    expect(html).not.toContain('md-alert')
    expect(html).toContain('[!HINT]')
  })

  it('accepts a title-only alert without leaving an empty paragraph', () => {
    const html = md.render('> [!TIP]\n')
    expect(html).toContain('md-alert-tip')
    expect(html).not.toContain('<p></p>')
  })

  it('keeps nested block content inside the card', () => {
    const html = md.render('> [!WARNING]\n> text\n>\n> - item\n')
    expect(html).toContain('md-alert-warning')
    expect(html).toContain('<li>item</li>')
    expect(html).not.toContain('<blockquote>')
  })
})
