import { describe, it, expect } from 'vitest'
import {
  autosaveAllowed,
  buildLineIndex,
  exceedsBytes,
  insertTab,
  isDirty,
  positionAt
} from '../../src/renderer/src/components/editBuffer'

/**
 * The edit buffer's pure half (file editing,; its design and black-box cases in were retired). Nothing here touches
 * the DOM, React or a timer: what the panel keeps is a textarea it does not control
 * (N-02), and every question it has to answer about that text — dirty or not, which line
 * the caret sits on, is the text too big to save (N-01) — is answered by one of these
 * functions. (Whether a watcher event is our own write coming back, B-22, is the
 * registry's `reconcileDisk` — see editRegistry.test.ts.)
 */

// N-02 — asked on every keystroke, so the length check comes first and the full string
// comparison only runs when the lengths already agree.
describe('isDirty (N-02)', () => {
  it('is clean when the text is byte-for-byte what was read', () => {
    expect(isDirty('port = 8080\n', 'port = 8080\n')).toBe(false)
  })

  it('is dirty when the same length holds different text — an edit in place', () => {
    expect(isDirty('port = 8080\n', 'port = 8081\n')).toBe(true)
  })

  it('is dirty when the length differs', () => {
    expect(isDirty('port = 8080\n', 'port = 8080\n\n')).toBe(true)
    expect(isDirty('', 'x')).toBe(true)
  })

  it('is clean again when an edit is typed back to the original', () => {
    expect(isDirty('a\nb', 'a\nb')).toBe(false)
  })
})

// §05 — "which line is the caret on" costs a scan from the top of the file, so a 512 KB
// file would re-scan 512 KB on every arrow key. The table is built once on open and read
// by binary search after that.
describe('buildLineIndex / positionAt (§05)', () => {
  it('starts every table at offset 0, empty file included', () => {
    expect(Array.from(buildLineIndex(''))).toEqual([0])
    expect(positionAt(buildLineIndex(''), 0, '')).toEqual({ line: 1, col: 1 })
  })

  it('keeps a file with no newline on line 1', () => {
    const text = 'hello'
    const index = buildLineIndex(text)
    expect(Array.from(index)).toEqual([0])
    expect(positionAt(index, 0, text)).toEqual({ line: 1, col: 1 })
    expect(positionAt(index, 3, text)).toEqual({ line: 1, col: 4 })
    expect(positionAt(index, 5, text)).toEqual({ line: 1, col: 6 })
  })

  it('gives a trailing newline its own empty last line', () => {
    const text = 'a\n'
    const index = buildLineIndex(text)
    expect(Array.from(index)).toEqual([0, 2])
    expect(positionAt(index, 2, text)).toEqual({ line: 2, col: 1 })
  })

  it('counts lines and columns across a multi-line file', () => {
    const text = 'a\nbb\nccc'
    const index = buildLineIndex(text)
    expect(Array.from(index)).toEqual([0, 2, 5])
    expect(positionAt(index, 1, text)).toEqual({ line: 1, col: 2 })
    expect(positionAt(index, 2, text)).toEqual({ line: 2, col: 1 })
    expect(positionAt(index, 5, text)).toEqual({ line: 3, col: 1 })
    expect(positionAt(index, 8, text)).toEqual({ line: 3, col: 4 })
  })

  // the textarea itself only ever holds LF, but the buffer this reads is the file's own
  // bytes, and a CRLF file's carriage return is a character sitting on the line
  it('handles CRLF text, where the carriage return belongs to the line before', () => {
    const text = 'a\r\nb'
    const index = buildLineIndex(text)
    expect(Array.from(index)).toEqual([0, 3])
    expect(positionAt(index, 1, text)).toEqual({ line: 1, col: 2 })
    expect(positionAt(index, 3, text)).toEqual({ line: 2, col: 1 })
  })

  // §05 — a BOM is kept in the buffer untouched, so it would otherwise read as column 1
  // being occupied and push the first real character to column 2
  it('does not let a leading BOM take up a column', () => {
    const text = '\uFEFFabc'
    const index = buildLineIndex(text)
    expect(positionAt(index, 0, text)).toEqual({ line: 1, col: 1 })
    expect(positionAt(index, 1, text)).toEqual({ line: 1, col: 1 })
    expect(positionAt(index, 2, text)).toEqual({ line: 1, col: 2 })
  })

  it('only discounts the BOM on line 1', () => {
    const text = '\uFEFFa\nbb'
    const index = buildLineIndex(text)
    expect(positionAt(index, 3, text)).toEqual({ line: 2, col: 1 })
    expect(positionAt(index, 4, text)).toEqual({ line: 2, col: 2 })
  })

  it('clamps an offset outside the text instead of answering nonsense', () => {
    const text = 'a\nbb'
    const index = buildLineIndex(text)
    expect(positionAt(index, 999, text)).toEqual({ line: 2, col: 3 })
    expect(positionAt(index, -5, text)).toEqual({ line: 1, col: 1 })
  })
})

// N-01 — the cap is bytes, not characters: 20 Chinese characters are 20 characters but 60
// bytes, and a character-count check would let a file three times the cap through.
describe('exceedsBytes (N-01)', () => {
  it('measures UTF-8 bytes, not characters', () => {
    const text = '密钥'.repeat(10)
    expect(text.length).toBe(20)
    expect(exceedsBytes(text, 50)).toBe(true)
    expect(exceedsBytes(text, 60)).toBe(false)
  })

  it('is false for plain text under the cap, and for nothing at all', () => {
    expect(exceedsBytes('port = 8080', 512 * 1024)).toBe(false)
    expect(exceedsBytes('', 0)).toBe(false)
  })

  it('counts an emoji as its four bytes rather than its two code units', () => {
    expect(exceedsBytes('🙂', 3)).toBe(true)
    expect(exceedsBytes('🙂', 4)).toBe(false)
  })
})

// the note is prose, so Tab means "indent this line", not "leave this box". The two
// spaces are written into the box by `setRangeText` (which keeps the undo history, B-09);
// this answers only where the caret has to land afterwards, and that is the whole reason
// the caller cannot just read `selectionStart` back — the browser has already moved it.
describe('insertTab', () => {
  it('leaves the caret just after the two spaces', () => {
    expect(insertTab('milk\neggs', 5, 5)).toEqual({ caret: 7 })
  })

  it('lands at the head of a replaced selection, not at its old end', () => {
    // the selected "and" is gone; the two spaces stand where it was
    expect(insertTab('milk and eggs', 5, 8)).toEqual({ caret: 7 })
  })

  it('reads a backwards selection forwards', () => {
    // a drag right-to-left hands over end < start, and the caret still belongs at the head
    expect(insertTab('milk and eggs', 8, 5)).toEqual({ caret: 7 })
  })

  it('works at the very end of the text', () => {
    expect(insertTab('milk', 4, 4)).toEqual({ caret: 6 })
  })

  it('works on an empty box', () => {
    expect(insertTab('', 0, 0)).toEqual({ caret: 2 })
  })

  it('clamps an offset past the end of the text', () => {
    expect(insertTab('milk', 99, 99)).toEqual({ caret: 6 })
  })
})

// three reasons a buffer must NOT write itself with nobody asking. The conflict one
// carries the weight: the file moved under us, the bar on screen is a question, and a timer
// answering it for the user is the very thing that bar exists to stop.
describe('autosaveAllowed', () => {
  const clean = { dirty: false, conflict: null, readOnly: null }

  it('says no while a conflict is waiting for an answer', () => {
    expect(
      autosaveAllowed({ ...clean, dirty: true, conflict: { text: null, unreadable: false } })
    ).toBe(false)
  })

  it('says no when the file may be read but not written', () => {
    expect(autosaveAllowed({ ...clean, dirty: true, readOnly: 'noPerm' })).toBe(false)
  })

  it('says no when there is nothing to save', () => {
    expect(autosaveAllowed(clean)).toBe(false)
  })

  it('says yes to plain unsaved text', () => {
    expect(autosaveAllowed({ ...clean, dirty: true })).toBe(true)
  })
})
