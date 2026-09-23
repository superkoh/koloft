import { describe, it, expect } from 'vitest'
import { directoryListingHtml } from '../../src/main/dirListing'

/** §05B/C-33: what a `file://` url pointing at a directory renders as. */
describe('directoryListingHtml', () => {
  it('lists every entry, directories first, each as an absolute file:// link', () => {
    const html = directoryListingHtml('/ws/docs', [
      { name: 'page.html', isDir: false },
      { name: 'img', isDir: true }
    ])
    expect(html).toContain('href="file:///ws/docs/img"')
    expect(html).toContain('href="file:///ws/docs/page.html"')
    expect(html.indexOf('img/')).toBeLessThan(html.indexOf('page.html'))
  })

  it('offers the parent, and does not offer one above the root', () => {
    expect(directoryListingHtml('/ws/docs', [])).toContain('href="file:///ws/"')
    expect(directoryListingHtml('/', [])).not.toContain('../')
  })

  it('reaches an entry whose name needs encoding', () => {
    const html = directoryListingHtml('/ws', [{ name: 'we ird #1.html', isDir: false }])
    expect(html).toContain('href="file:///ws/we%20ird%20%231.html"')
  })

  it('is not a place a file name can inject markup', () => {
    const html = directoryListingHtml('/ws', [
      { name: '<img src=x onerror=alert(1)>.txt', isDir: false }
    ])
    expect(html).not.toContain('<img src=x')
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;.txt')
  })
})
