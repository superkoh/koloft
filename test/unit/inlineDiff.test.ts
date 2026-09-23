import { describe, it, expect } from 'vitest'
import { CUT_MARK, MAX_ROW_CHARS, parseUnifiedDiff } from '../../src/renderer/src/inlineDiff'

const FULL = [
  'diff --git a/f.txt b/f.txt',
  'index 4936548..7d4b7ee 100644',
  '--- a/f.txt',
  '+++ b/f.txt',
  '@@ -1,11 +1,12 @@',
  '-a',
  '+A1',
  ' ',
  ' CHANGED2',
  ' c',
  ' d',
  ' e',
  ' f',
  '-g',
  '+gX',
  ' h',
  ' i',
  ' j',
  '+NEWTAIL'
].join('\n')

describe('parseUnifiedDiff', () => {
  it('maps a full-context hunk to ordered ctx/add/del rows with correct old/new numbers', () => {
    const { rows, hasChange } = parseUnifiedDiff(FULL)
    expect(hasChange).toBe(true)
    expect(rows).toHaveLength(14)
    expect(rows[0]).toEqual({ kind: 'del', oldNo: 1, newNo: null, text: 'a' })
    expect(rows[1]).toEqual({ kind: 'add', oldNo: null, newNo: 1, text: 'A1' })
    expect(rows[2]).toEqual({ kind: 'ctx', oldNo: 2, newNo: 2, text: '' })
    expect(rows[8]).toEqual({ kind: 'del', oldNo: 8, newNo: null, text: 'g' })
    expect(rows[9]).toEqual({ kind: 'add', oldNo: null, newNo: 8, text: 'gX' })
    expect(rows[13]).toEqual({ kind: 'add', oldNo: null, newNo: 12, text: 'NEWTAIL' })
  })

  it('reconstructs the old and new file text (for per-line syntax highlighting)', () => {
    const { oldText, newText } = parseUnifiedDiff(FULL)
    expect(oldText).toBe('a\n\nCHANGED2\nc\nd\ne\nf\ng\nh\ni\nj')
    expect(newText).toBe('A1\n\nCHANGED2\nc\nd\ne\nf\ngX\nh\ni\nj\nNEWTAIL')
  })

  it('reconstructed line counts match the rows on each side (gutter alignment invariant)', () => {
    const { rows, oldText, newText } = parseUnifiedDiff(FULL)
    const oldRows = rows.filter((r) => r.kind !== 'add').length
    const newRows = rows.filter((r) => r.kind !== 'del').length
    expect(oldText.split('\n')).toHaveLength(oldRows)
    expect(newText.split('\n')).toHaveLength(newRows)
  })

  it('skips the "\\ No newline at end of file" marker without consuming a line number', () => {
    const diff = `@@ -1,1 +1,1 @@
-old
\\ No newline at end of file
+new
\\ No newline at end of file`
    const { rows } = parseUnifiedDiff(diff)
    expect(rows).toEqual([
      { kind: 'del', oldNo: 1, newNo: null, text: 'old' },
      { kind: 'add', oldNo: null, newNo: 1, text: 'new' }
    ])
  })

  it('reports no change for an empty diff or a binary-files marker (caller shows the plain file)', () => {
    expect(parseUnifiedDiff('')).toEqual({ rows: [], oldText: '', newText: '', hasChange: false })
    const bin = parseUnifiedDiff(
      'diff --git a/x.png b/x.png\nBinary files a/x.png and b/x.png differ\n'
    )
    expect(bin.hasChange).toBe(false)
    expect(bin.rows).toEqual([])
  })

  it('an all-additions diff (untracked/new file) is all add rows, empty old text', () => {
    const diff = `@@ -0,0 +1,2 @@
+first
+second`
    const { rows, oldText, newText, hasChange } = parseUnifiedDiff(diff)
    expect(hasChange).toBe(true)
    expect(rows.map((r) => r.kind)).toEqual(['add', 'add'])
    expect(rows[0].newNo).toBe(1)
    expect(rows[1].newNo).toBe(2)
    expect(oldText).toBe('')
    expect(newText).toBe('first\nsecond')
  })

  it('cuts a row longer than MAX_ROW_CHARS so one huge line cannot stall highlight/layout', () => {
    const long = 'x'.repeat(MAX_ROW_CHARS * 3)
    const d = ['--- a/f', '+++ b/f', '@@ -1,1 +1,2 @@', ' short', '+' + long].join('\n')
    const { rows, newText } = parseUnifiedDiff(d)
    expect(rows[0].text).toBe('short')
    expect(rows[1].text).toBe('x'.repeat(MAX_ROW_CHARS) + CUT_MARK)
    expect(newText).toBe('short\n' + rows[1].text)
  })
})
