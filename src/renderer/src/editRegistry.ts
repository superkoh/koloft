import type { EditFingerprint, EditOpenResult } from '@shared/types'
import { isDirty, sameStamp } from './components/editBuffer'

/**
 * Every open edit buffer in the app, and the only place that answers "is there unsaved
 * work here" (B-24…B-28).
 *
 * It is a module-level map rather than React state for two reasons, both forced by the
 * shape of the panel. The buffer has to outlive its component: switching SESSION unmounts
 * every file artifact of the session left behind (WorkbenchPane's `fileTabs`), and B-30
 * says switching away loses nothing. And the guards that read it are not in the panel at
 * all — the close-tab question, the close-session question and the quit question each ask
 * from a different component, and none of them owns the editor.
 *
 * The text is kept here on every keystroke, which is what makes "Save & close" work for a
 * tab whose textarea is not even mounted. It is never written anywhere else: no draft
 * file, no layout entry, no log (§06, N-04).
 */

export interface DirtyTab {
  /** the CONVERSATION TAB whose panel holds this buffer (D8). It used to be
   *  the claude session id, which `/clear` and `/resume` changed under a buffer nobody
   *  had touched — and the whole `rebindEdits` machinery existed to chase that. */
  ownerTabId: string
  /** the panel tab inside it — `wt<n>` (never `files`: the pinned tab has no buffer) */
  tabId: string
  path: string
}

export interface EditEntry {
  path: string
  /** what the file uses on disk; the save puts it back (the textarea only ever holds LF) */
  eol: 'lf' | 'crlf'
  /** B-04's reason this file may be read but not changed, or null */
  readOnly: EditOpenResult['readOnly']
  /** the file's text as last seen on disk — what "dirty" is measured against */
  original: string
  /** what the textarea holds now */
  text: string
  /** what the next save must still find on disk (B-20) */
  stamp: EditFingerprint
  /** when that save landed, for the strip's "Saved 14:32:07" */
  savedAt: number | null
  /**
   * B-20 — the disk moved while this buffer was dirty.
   *
   * `text` is what disk holds, and null means we do not have it. The two ways that happens
   * are different offers to the user, which is what `unreadable` separates: the watcher
   * reports a fingerprint and nothing else, so the text can still be fetched when the diff
   * is asked for, while a file that is now over the reading cap or binary can never be
   * compared at all and must not be offered a view that would stay empty.
   */
  conflict: { text: string | null; stamp: EditFingerprint; unreadable: boolean } | null
  /** B-23 — the last save failure, in a sentence the user can act on */
  error: string | null
  /** the caret, so a remount (a session switch) puts it back where it was */
  selection: { start: number; end: number }
}

const entries = new Map<string, EditEntry>()
const listeners = new Set<() => void>()

/** Both halves are opaque tokens with no spaces in them — a conversation tab id is a pty
 *  id, a panel tab id is `wt<n>` or `files` — so a space both separates them unambiguously
 *  and keeps this file readable as text. (It was a NUL byte, which made every diff of this
 *  file read as binary.) */
const SEP = ' '
const keyOf = (ownerTabId: string, tabId: string): string => ownerTabId + SEP + tabId

function notify(): void {
  for (const cb of [...listeners]) cb()
}

/** The textarea turns every CRLF (and every lone CR) into LF on the way in — measured, §05
 *  — so the baseline has to be flattened the same way or a Windows file would be "changed"
 *  before a key was pressed. Only files that are all-LF or all-CRLF get this far: a mixed
 *  one is refused at `edit.open` as read-only, precisely because this flattening would
 *  rewrite lines nobody touched. */
function flatten(text: string): string {
  return text.includes('\r') ? text.replace(/\r\n?/g, '\n') : text
}

export function beginEdit(
  ownerTabId: string,
  tabId: string,
  init: {
    path: string
    text: string
    eol: 'lf' | 'crlf'
    stamp: EditFingerprint
    readOnly: EditOpenResult['readOnly']
  }
): void {
  const text = flatten(init.text)
  entries.set(keyOf(ownerTabId, tabId), {
    path: init.path,
    eol: init.eol,
    readOnly: init.readOnly,
    original: text,
    text,
    stamp: init.stamp,
    savedAt: null,
    conflict: null,
    error: null,
    selection: { start: 0, end: 0 }
  })
  notify()
}

/** Forget the buffer entirely — the tab closed, or left edit mode with nothing unsaved. */
export function endEdit(ownerTabId: string, tabId: string): void {
  if (entries.delete(keyOf(ownerTabId, tabId))) notify()
}

/** Drop a closed conversation tab's CLEAN buffers; a dirty one stays (the store's
 *  `removeTab` says why). */
export function endEditsOf(ownerTabId: string): void {
  for (const t of allEditTabs()) {
    if (t.ownerTabId === ownerTabId && !isTabDirty(ownerTabId, t.tabId))
      endEdit(ownerTabId, t.tabId)
  }
}

export function getEntry(ownerTabId: string, tabId: string): EditEntry | undefined {
  return entries.get(keyOf(ownerTabId, tabId))
}

/**
 * The textarea's current value, on every keystroke.
 *
 * Deliberately silent unless the dirty flag actually FLIPS: the strip's dot, the File
 * menu's Save item and the tab cap all only care about the flag, and waking React on every
 * character is exactly the cost N-02's uncontrolled textarea exists to avoid.
 */
export function setText(ownerTabId: string, tabId: string, text: string): void {
  const e = entries.get(keyOf(ownerTabId, tabId))
  if (!e) return
  const was = isDirty(e.original, e.text)
  e.text = text
  if (isDirty(e.original, text) !== was) notify()
}

export function setSelection(ownerTabId: string, tabId: string, start: number, end: number): void {
  const e = entries.get(keyOf(ownerTabId, tabId))
  if (e) e.selection = { start, end }
}

/** The file on disk is now the truth: a clean buffer following a change (B-15's silent
 *  reload) and the conflict bar's Reload both land here. */
export function applyDisk(
  ownerTabId: string,
  tabId: string,
  text: string,
  stamp: EditFingerprint
): void {
  const e = entries.get(keyOf(ownerTabId, tabId))
  if (!e) return
  e.original = flatten(text)
  e.text = e.original
  e.stamp = stamp
  e.conflict = null
  e.error = null
  notify()
}

export function noteConflict(
  ownerTabId: string,
  tabId: string,
  c: { text: string | null; stamp: EditFingerprint; unreadable: boolean }
): void {
  const e = entries.get(keyOf(ownerTabId, tabId))
  if (!e) return
  // flattened like everything else stored here: the file keeps its CRLF, the buffer cannot
  // (the textarea flattens on the way in), and a diff between the two forms calls every
  // single line changed
  e.conflict = { ...c, text: c.text === null ? null : flatten(c.text) }
  notify()
}

export function clearConflict(ownerTabId: string, tabId: string): void {
  const e = entries.get(keyOf(ownerTabId, tabId))
  if (!e || !e.conflict) return
  e.conflict = null
  notify()
}

export function isTabDirty(ownerTabId: string, tabId: string): boolean {
  const e = entries.get(keyOf(ownerTabId, tabId))
  return !!e && isDirty(e.original, e.text)
}

function dirtyList(match?: string): DirtyTab[] {
  const out: DirtyTab[] = []
  for (const [key, e] of entries) {
    if (!isDirty(e.original, e.text)) continue
    const at = key.indexOf(SEP)
    const ownerTabId = key.slice(0, at)
    if (match !== undefined && ownerTabId !== match) continue
    out.push({ ownerTabId, tabId: key.slice(at + 1), path: e.path })
  }
  return out
}

/**
 * ⇧⌘R — carry every buffer of one conversation tab onto the tab's new pty id.
 *
 * A restart is the only event that changes a conversation tab's id, and since the panel
 * became tab-keyed (P1) these entries are keyed by it too. Before that they hung off
 * the claude session id, which a restart preserves — so what used to need nothing now
 * needs this, and without it a buffer with unsaved text goes silently unreachable: the
 * editor reads `getEntry(newId, …)` and finds nothing, so the pane reverts to the bytes on
 * disk, the strip's unsaved dot goes out, `dirtyIn(newId)` comes back empty so ⌘W closes
 * the session without asking, and the text sits orphaned under an id no tab carries until
 * the quit guard names a file it can no longer reveal.
 *
 * Called from the same store step that moves `workbench`, `workbenchOpen`,
 * `workbenchFetched` and `openFiles`, so the whole of a tab's panel state travels together
 * or not at all.
 */
export function rekeyOwner(oldOwnerTabId: string, newOwnerTabId: string): void {
  let moved = false
  for (const [key, e] of [...entries]) {
    const at = key.indexOf(SEP)
    if (key.slice(0, at) !== oldOwnerTabId) continue
    entries.delete(key)
    entries.set(keyOf(newOwnerTabId, key.slice(at + 1)), e)
    moved = true
  }
  // the dirty dots, the editor panes and the quit guard all read through the subscription
  if (moved) notify()
}

/** Every open buffer, dirty or not — what the panel sweeps by when a tab goes away. */
export function allEditTabs(): DirtyTab[] {
  const out: DirtyTab[] = []
  for (const [key, e] of entries) {
    const at = key.indexOf(SEP)
    out.push({ ownerTabId: key.slice(0, at), tabId: key.slice(at + 1), path: e.path })
  }
  return out
}

/**
 * B-15/B-20/B-22 — the disk has been looked at; bring the buffer in line with it.
 *
 * One decision for every caller (the watcher's event, the read it triggers, the editor's
 * own mount after a session switch): a stamp the buffer already agreed with — our own
 * save's echo included — is nothing; a file holding exactly what the box holds is nothing
 * to disagree about either (our own save, read back before its answer landed) and only
 * makes the buffer clean; a clean buffer follows the file; a dirty one gets the conflict
 * bar and nothing overwritten. `text` is null when only a stamp is known (the watcher's
 * event): then a clean buffer is left for the caller to read, and a conflict already known
 * by that stamp is not re-noted, which would throw away its text.
 *
 * Dirtiness is judged HERE, against the buffer as it is now, never where the read was
 * started: the read is an IPC round trip long, and a key pressed inside it is the one
 * thing this editor could otherwise overwrite without asking.
 */
export function reconcileDisk(
  ownerTabId: string,
  tabId: string,
  disk: { text: string | null; stamp: EditFingerprint }
): void {
  const e = entries.get(keyOf(ownerTabId, tabId))
  if (!e || sameStamp(disk.stamp, e.stamp)) return
  if (disk.text !== null) {
    if (!isDirty(e.original, e.text) || flatten(disk.text) === e.text) {
      applyDisk(ownerTabId, tabId, disk.text, disk.stamp)
      return
    }
  } else if (e.conflict && sameStamp(e.conflict.stamp, disk.stamp)) return
  noteConflict(ownerTabId, tabId, { text: disk.text, stamp: disk.stamp, unreadable: false })
}

export function dirtyTabsOf(ownerTabId: string): DirtyTab[] {
  return dirtyList(ownerTabId)
}

export function allDirtyTabs(): DirtyTab[] {
  return dirtyList()
}

/** B-23 — one sentence per failure, in ordinary words. The IPC boundary keeps only the
 *  message, so the `KOLOFT_*` string is what there is to match on. */
function saveFailureMessage(err: unknown): string {
  const msg = String((err as Error)?.message ?? '')
  if (msg.includes('KOLOFT_NO_PERM')) return 'Not allowed to write this file.'
  // the folder, not the file: writing the same path again would fail the same way, so the
  // sentence must not hint at trying — unlike KOLOFT_GONE, where the path can be made again
  if (msg.includes('KOLOFT_DIR_GONE')) return 'The folder is gone — nothing was written.'
  if (msg.includes('KOLOFT_GONE')) return 'This file is not there any more.'
  if (msg.includes('KOLOFT_TOO_LARGE')) return 'Too big to save — the limit is 1 MB.'
  if (msg.includes('KOLOFT_NOT_FILE')) return 'This is not a plain file any more.'
  return 'Could not save this file.'
}

/**
 * Write one buffer. Never opens a dialog and never touches the screen: the caller decides
 * what a conflict or a failure looks like, because the same three answers have to serve the
 * ⌘S in the panel and the "Save & close" in a modal.
 *
 * `force` is the conflict view's "Keep mine" and reaches main as the literal `true` it
 * insists on. The fingerprint sent is the one this buffer opened (or last saved) with, so a
 * plain save after a refused one is refused again — the state machine's only way out is
 * Reload or Keep mine.
 */
export function saveTab(
  ownerTabId: string,
  tabId: string,
  opts?: { force?: boolean }
): Promise<SaveResult> {
  const key = keyOf(ownerTabId, tabId)
  const before = inFlight.get(key)
  // queued, never parallel: the second caller waits for the first and only then looks at
  // the buffer, so it either finds it clean (nothing left to write) or writes the newer
  // text with the fingerprint the first save just established
  const next = (): Promise<SaveResult> => writeOnce(key, opts)
  const p = before ? before.then(next, next) : next()
  inFlight.set(key, p)
  const done = (): void => {
    if (inFlight.get(key) === p) inFlight.delete(key)
  }
  p.then(done, done)
  return p
}

type SaveResult = 'saved' | 'stale' | 'failed' | 'clean'

/**
 * One save may be in flight per buffer, and the next one waits for it.
 *
 * Two saves of the same buffer used to race, and's autosave made that ordinary:
 * mousedown blurs the note (save #1 goes out), mouseup unmounts it (save #2 goes out with
 * the SAME pre-save fingerprint), main refuses the second as stale, and a conflict bar
 * comes up over a buffer that is already on disk — with autosave then blocked until the
 * user answers a question about nothing. The ⌘S double-tap had the same shape all along.
 */
const inFlight = new Map<string, Promise<SaveResult>>()

async function writeOnce(key: string, opts?: { force?: boolean }): Promise<SaveResult> {
  const e = entries.get(key)
  if (!e) return 'clean'
  if (!opts?.force && !isDirty(e.original, e.text)) return 'clean'
  // what is SENT is the baseline a success establishes — the user may type on while the
  // write is in flight, and those keystrokes are unsaved work, not part of this save
  const sent = e.text
  try {
    const r = await window.api.edit.write(
      e.path,
      sent,
      e.stamp,
      opts?.force ? { force: true, eol: e.eol } : { eol: e.eol }
    )
    if (!r.ok) {
      // main answers with null when what it found is too big to read or is not text at
      // all: still a conflict, but one with nothing to show side by side
      const disk: string | null = r.text ?? null
      e.conflict = {
        text: disk === null ? null : flatten(disk),
        stamp: { mtimeMs: r.mtimeMs, size: r.size },
        unreadable: disk === null
      }
      notify()
      return 'stale'
    }
    e.original = sent
    e.stamp = { mtimeMs: r.mtimeMs, size: r.size }
    e.savedAt = Date.now()
    e.conflict = null
    e.error = null
    notify()
    return 'saved'
  } catch (err) {
    e.error = saveFailureMessage(err)
    notify()
    return 'failed'
  }
}

/** Throw the typing away, keep the buffer open on the file's own text. */
export function discardTab(ownerTabId: string, tabId: string): void {
  const e = entries.get(keyOf(ownerTabId, tabId))
  if (!e) return
  e.text = e.original
  e.conflict = null
  e.error = null
  notify()
}

/**
 * B-12/B-13 — is the surface in front of the user an EDITOR right now?
 *
 * The panel owns the answer, but the two things that consult it are app-level: the Find
 * menu item (which has no meaning over a textarea — the find bar paints highlights over
 * rendered text) and the reload key. They ride the same subscription the dirty flag does,
 * so a menu rebuild happens on the same signal rather than on a second one.
 */
let editingNow = false

export function setEditingActive(active: boolean): void {
  if (active === editingNow) return
  editingNow = active
  notify()
}

export function editingActive(): boolean {
  return editingNow
}

export function subscribeDirty(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}
