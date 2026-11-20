import { describe, it, expect } from 'vitest'
import { isUnderAnyRoot } from '../../src/core/isUnderAnyRoot'

describe('isUnderAnyRoot (a directory prefix, not a string prefix)', () => {
  const roots = ['/Users/x/ws', '/Users/x/other']

  it('accepts a file under a root, and the root itself', () => {
    expect(isUnderAnyRoot('/Users/x/ws/docs/a.html', roots)).toBe(true)
    expect(isUnderAnyRoot('/Users/x/ws', roots)).toBe(true)
    expect(isUnderAnyRoot('/Users/x/other/b.png', roots)).toBe(true)
  })

  it('refuses a sibling directory that merely shares the prefix', () => {
    expect(isUnderAnyRoot('/Users/x/ws-evil/a.txt', roots)).toBe(false)
    expect(isUnderAnyRoot('/Users/x/wsx', roots)).toBe(false)
  })

  it('refuses a path outside every root, including via traversal', () => {
    expect(isUnderAnyRoot('/Users/x/.ssh/id_rsa', roots)).toBe(false)
    expect(isUnderAnyRoot('/Users/x/ws/../.ssh/id_rsa', roots)).toBe(false)
    expect(isUnderAnyRoot('/Users/x/ws/docs/../../.ssh/id_rsa', roots)).toBe(false)
  })

  it('refuses everything when no root is declared', () => {
    expect(isUnderAnyRoot('/Users/x/ws/docs/a.html', [])).toBe(false)
  })

  it('reads a trailing separator on a root as the same root', () => {
    expect(isUnderAnyRoot('/Users/x/ws/docs/a.html', ['/Users/x/ws/'])).toBe(true)
  })
})
