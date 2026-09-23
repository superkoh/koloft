/**
 * The edit buffer's pure half: everything the file editor has to work out about the text
 * it is holding, with no DOM, no React state and no timer in it.
 *
 * The text itself lives in an uncontrolled textarea (N-02) — React never re-writes the
 * body, both for speed on a large file and because rewriting it mid-composition swallows
 * the candidate characters of a Chinese input method. So the buffer's questions all arrive
 * here as plain strings, and every answer is a function of its arguments alone.
 */

/** A file's identity on disk at one moment: the modification time and the byte count. */
export interface FileStamp {
  mtimeMs: number
  size: number
}

/** B-22 — the stamp is what tells our own save's echo from a stranger's write. It is an
 *  early warning only: the watcher polls every 500 ms and can merge a real change behind
 *  our own write, so the fingerprint re-checked at save time stays the reliable gate. */
export function sameStamp(a: FileStamp, b: FileStamp): boolean {
  return a.mtimeMs === b.mtimeMs && a.size === b.size
}

/** N-02 — asked on every keystroke, so a differing length answers without walking the
 *  string. Typing an edit back to the original is clean again, which is why this compares
 *  content rather than remembering that a key was pressed. */
export function isDirty(original: string, current: string): boolean {
  if (original.length !== current.length) return true
  return original !== current
}

/**
 * §05 — the offset each line starts at, so "which line is the caret on" is a binary search
 * instead of a scan from the top of the file. Built once when the file opens: on a 512 KB
 * file the scan is the whole file, and the status bar asks after every cursor move.
 *
 * Index 0 is always 0 — every file has a line 1, the empty file included — and a trailing
 * newline opens one more (empty) line, matching what an editor shows the caret on.
 */
export function buildLineIndex(text: string): Uint32Array {
  const starts: number[] = [0]
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) starts.push(i + 1)
  return Uint32Array.from(starts)
}

/**
 * §05 — the 1-based line and column of an offset, for the status bar.
 *
 * A leading byte order mark is kept in the buffer byte for byte (B-18 keeps it on the way
 * back out), but it is not something the user typed and it must not occupy column 1 —
 * so on line 1 of a file that has one, the first real character is column 1.
 */
export function positionAt(
  index: Uint32Array,
  offset: number,
  text: string
): { line: number; col: number } {
  const at = Math.max(0, Math.min(text.length, offset))
  let lo = 0
  let hi = index.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (index[mid] <= at) lo = mid
    else hi = mid - 1
  }
  const bom = lo === 0 && text.charCodeAt(0) === 0xfeff ? 1 : 0
  return { line: lo + 1, col: Math.max(1, at - index[lo] - bom + 1) }
}

const encoder = new TextEncoder()

/** N-01 — the size cap counts UTF-8 bytes, not characters: twenty Chinese characters are
 *  twenty characters and sixty bytes, and counting characters would let a file three times
 *  the cap through. */
export function exceedsBytes(text: string, maxBytes: number): boolean {
  return encoder.encode(text).length > maxBytes
}

/** What one Tab writes when the pane is holding prose. Two spaces, because a note is
 *  a list of lines a person reads, not code an indent width applies to. */
export const TAB_TEXT = '  '

/**
 * where the caret lands when a Tab press writes two spaces into a prose buffer:
 * right after them, at the head of whatever the press replaced.
 *
 * Only the FALLBACK path needs this. Normally the pane asks the browser to type the spaces
 * (`execCommand('insertText')`), which places the caret itself and keeps the undo history
 * (B-09); this is for the day that call answers no, when the pane writes the spaces with
 * `setRangeText` and has to put the caret back by hand.
 *
 * The caret and nothing else. The new TEXT is not built here on purpose: re-assigning the
 * whole `value` moves the caret to the end and throws the undo history away, so a `value`
 * returned from here would be a second answer nobody uses, free to drift from the one the
 * box actually holds.
 *
 * Out-of-range offsets are clamped and a backwards pair is read forwards, because the caller
 * is a DOM node's `selectionStart`/`selectionEnd`.
 */
export function insertTab(value: string, start: number, end: number): { caret: number } {
  const lo = Math.max(0, Math.min(value.length, Math.min(start, end)))
  return { caret: lo + TAB_TEXT.length }
}

/** how long after the last keystroke an autosaving buffer writes itself. */
export const AUTOSAVE_DELAY_MS = 600

/**
 * may the buffer save itself right now, with nobody asking?
 *
 * Three noes. A conflict means the file moved under us and the bar on screen is a question
 * the user has not answered yet — writing over it by timer is exactly the thing the bar
 * exists to prevent, so autosave waits for Reload or Keep mine. A read-only buffer has
 * nothing to write to. And a clean buffer has nothing to write. ⌘S does not come through
 * here at all: a person pressing a key is not this, and inside the note that key goes
 * straight to the registry's save (App.tsx's `onSave`, which routes on where the caret is).
 */
export function autosaveAllowed(e: {
  dirty: boolean
  conflict: unknown
  readOnly: unknown
}): boolean {
  return e.dirty && !e.conflict && !e.readOnly
}
