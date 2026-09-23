import { describe, it, expect } from 'vitest'
import { openDropTarget } from '../../src/main/openDrop'

// What the `open` shim hands the main process. The two fields are not interchangeable:
// a URL run through the path branch becomes `<cwd>/http:/localhost:5173` — a target no
// router can resolve and the exact silent failure IMPL-3 warns about.

describe('openDropTarget', () => {
  it('takes a url verbatim, never resolving it against the cwd', () => {
    expect(openDropTarget({ url: 'http://localhost:5173/a', cwd: '/repo' })).toBe(
      'http://localhost:5173/a'
    )
  })

  it('resolves a relative path against the cwd', () => {
    expect(openDropTarget({ path: 'docs/page.html', cwd: '/repo' })).toBe('/repo/docs/page.html')
  })

  it('leaves an absolute path alone', () => {
    expect(openDropTarget({ path: '/repo/docs/page.html', cwd: '/elsewhere' })).toBe(
      '/repo/docs/page.html'
    )
  })

  it('prefers the url when a drop carries both (SEC-14: the shim fills one or the other)', () => {
    expect(openDropTarget({ url: 'https://example.com/x', path: '/repo/x', cwd: '/repo' })).toBe(
      'https://example.com/x'
    )
  })

  it('answers empty for a drop with neither field', () => {
    expect(openDropTarget({ cwd: '/repo' })).toBe('')
    expect(openDropTarget({ url: '', path: '', cwd: '/repo' })).toBe('')
  })
})
