import { describe, it, expect } from 'vitest'
import {
  extOf,
  basename,
  dirname,
  previewKindForPath,
  isWebPagePath,
  stateAfterReadError,
  VIEWABLE_EXTENSIONS
} from '@shared/preview'

describe('what a Workbench file view shows after a read fails (BB-N10)', () => {
  it('a passing read error keeps the last good text on a reload, and is an error only on the first read of that file', () => {
    expect(stateAfterReadError('EMFILE: too many open files', false)).toBeNull()
    expect(stateAfterReadError('EMFILE: too many open files', true)).toBe('error')
  })

  it('a gone, too large or binary file says so on any read', () => {
    expect(stateAfterReadError('Error: KOLOFT_READ_FAILED', false)).toBe('missing')
    expect(stateAfterReadError('Error: KOLOFT_NOT_FILE', false)).toBe('missing')
    expect(stateAfterReadError('Error: KOLOFT_TOO_LARGE', false)).toBe('tooLarge')
    expect(stateAfterReadError('Error: KOLOFT_BINARY', false)).toBe('binary')
  })
})

describe('preview helpers', () => {
  it('extOf lowercases and includes the dot; empty for no extension', () => {
    expect(extOf('a/b/File.MD')).toBe('.md')
    expect(extOf('IMG.PNG')).toBe('.png')
    expect(extOf('/no/ext/here')).toBe('')
    expect(extOf('archive.tar.gz')).toBe('.gz')
    expect(extOf('.gitignore')).toBe('.gitignore')
  })

  it('basename handles both separators and trailing content', () => {
    expect(basename('/a/b/c.md')).toBe('c.md')
    expect(basename('a\\b\\c.md')).toBe('c.md')
    expect(basename('lonely.txt')).toBe('lonely.txt')
  })

  it('dirname strips the last segment, on the same string-only footing as basename', () => {
    expect(dirname('/a/b/c.ts')).toBe('/a/b')
    expect(dirname('/a')).toBe('/')
    expect(dirname('a.ts')).toBe('')
    expect(dirname('a/b.ts')).toBe('a')
  })

  it('dirname ignores a trailing separator', () => {
    expect(dirname('/a/b/')).toBe('/a')
    expect(dirname('/a/')).toBe('/')
    expect(dirname('a/')).toBe('')
  })

  it('dirname handles backslash separators the way basename does', () => {
    expect(dirname('a\\b\\c.md')).toBe('a\\b')
    expect(dirname('C:\\x.md')).toBe('C:')
    expect(basename(dirname('a\\b\\c.md'))).toBe('b')
  })

  it('dirname bottoms out at an empty string rather than looping, so a file tab label grown one parent at a time always ends', () => {
    expect(dirname('/')).toBe('')
    expect(dirname('')).toBe('')
    expect(dirname(dirname('/a'))).toBe('')
  })

  it('previewKindForPath maps known extensions and null otherwise', () => {
    expect(previewKindForPath('notes.md')).toBe('markdown')
    expect(previewKindForPath('shot.jpeg')).toBe('image')
    expect(previewKindForPath('doc.pdf')).toBe('pdf')
    expect(previewKindForPath('main.ts')).toBeNull()
    expect(previewKindForPath('Makefile')).toBeNull()
  })

  it('D6: a page is no longer a preview kind, it is a Browser page', () => {
    expect(previewKindForPath('page.HTML')).toBeNull()
    expect(previewKindForPath('page.htm')).toBeNull()
    expect(isWebPagePath('page.HTML')).toBe(true)
    expect(isWebPagePath('page.htm')).toBe(true)
    expect(isWebPagePath('notes.md')).toBe(false)
  })

  it('D6: .html stays in-app viewable, so the tree filter and the open shim keep it', () => {
    expect(VIEWABLE_EXTENSIONS).toContain('.html')
    expect(VIEWABLE_EXTENSIONS).toContain('.md')
    expect(VIEWABLE_EXTENSIONS).not.toContain('.ts')
  })
})
