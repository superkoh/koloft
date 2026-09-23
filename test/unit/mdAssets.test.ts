import { describe, it, expect } from 'vitest'
import MarkdownIt from 'markdown-it'
import { assets } from '../../src/renderer/src/markdown/assets'

const md = new MarkdownIt().use(assets)
const env = { srcPath: '/ws/docs/design.md' }

describe('assets', () => {
  it('rewrites a relative image to the local file protocol', () => {
    const html = md.render('![pic](./pic.png)\n', env)
    expect(html).toContain('src="koloft-file://localhost/ws/docs/pic.png"')
    expect(html).toContain('alt="pic"')
  })

  it('walks up out of the document directory', () => {
    const html = md.render('![pic](../assets/pic.png)\n', env)
    expect(html).toContain('src="koloft-file://localhost/ws/assets/pic.png"')
  })

  it('keeps an absolute path as itself', () => {
    const html = md.render('![pic](/ws/assets/pic.png)\n', env)
    expect(html).toContain('src="koloft-file://localhost/ws/assets/pic.png"')
  })

  it('percent-encodes a path with spaces and non-ASCII', () => {
    const html = md.render('![pic](<./my pic.png>)\n', { srcPath: '/ws/设计/a.md' })
    expect(html).toContain('koloft-file://localhost/ws/%E8%AE%BE%E8%AE%A1/my%20pic.png')
  })

  it('blocks an http image and shows its address instead', () => {
    const html = md.render('![badge](https://img.example.com/badge.svg)\n', env)
    expect(html).toContain('md-img-blocked')
    expect(html).toContain('https://img.example.com/badge.svg')
    expect(html).not.toContain('<img')
  })

  it('blocks a protocol-relative image too', () => {
    const html = md.render('![badge](//img.example.com/badge.svg)\n', env)
    expect(html).toContain('md-img-blocked')
    expect(html).not.toContain('<img')
  })

  it('leaves an inline data: image alone (no network involved)', () => {
    const html = md.render('![dot](data:image/gif;base64,R0lGOD)\n', env)
    expect(html).toContain('src="data:image/gif;base64,R0lGOD"')
  })

  it('carries the source path so a 403 can be shown as a placeholder with its path', () => {
    const html = md.render('![pic](./pic.png)\n', env)
    expect(html).toContain('data-path="./pic.png"')
  })

  it('escapes the blocked address rather than letting it close the tag', () => {
    const html = md.render('![x](https://e.com/"><script>a</script>)\n', env)
    expect(html).not.toContain('<script>')
  })
})
