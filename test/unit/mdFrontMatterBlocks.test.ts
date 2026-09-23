import { describe, it, expect } from 'vitest'
import { parseFrontMatter } from '../../src/renderer/src/markdown/frontMatter'

describe('parseFrontMatter with block structure', () => {
  it('folds an indented list into the value of the key above it', () => {
    const pairs = parseFrontMatter('title: 设计稿\ntags:\n  - a\n  - b\nowner: koh\n')
    expect(pairs).toEqual([
      ['title', '设计稿'],
      ['tags', '- a - b'],
      ['owner', 'koh']
    ])
  })

  it('keeps the inline list form untouched', () => {
    expect(parseFrontMatter('tags: [a, b]\n')).toEqual([['tags', '[a, b]']])
  })

  it('still refuses a block that does not start with a key', () => {
    expect(parseFrontMatter('  - orphan\ntitle: x\n')).toBeNull()
  })

  it('still refuses a line that is neither a pair nor indented', () => {
    expect(parseFrontMatter('title: x\nnot a pair line\n')).toBeNull()
  })

  it('still refuses an unclosed inline value', () => {
    expect(parseFrontMatter('a: [1, 2\n')).toBeNull()
  })
})
