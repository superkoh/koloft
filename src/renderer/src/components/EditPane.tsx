import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type JSX
} from 'react'
import { LuX } from 'react-icons/lu'
import {
  AUTOSAVE_DELAY_MS,
  autosaveAllowed,
  buildLineIndex,
  exceedsBytes,
  insertTab,
  isDirty,
  positionAt,
  TAB_TEXT
} from './editBuffer'
import { diffLines } from './editDiff'
import { InlineDiff } from './InlineDiff'
import { useStore } from '../store'
import {
  applyDisk,
  clearConflict,
  getEntry,
  noteConflict,
  reconcileDisk,
  saveTab,
  setSelection,
  setText,
  subscribeDirty
} from '../editRegistry'

/**
 * B-07…B-22 — the editor itself: one plain textarea, a status strip, and the two bars that
 * appear when the file moves under it.
 *
 * The textarea is UNCONTROLLED (N-02) and that is not a preference. React re-writing the
 * body on every keystroke costs 28ms a character on a big file (measured, §05), and
 * re-writing it mid-composition swallows the candidate characters of a Chinese input
 * method. So the DOM node owns the text, this component only ever reads it, and the one
 * place that writes it back is `syncFromRegistry` below — the reload paths, which B-09
 * already warns cut the undo history.
 *
 * Every piece of state that has to outlive the component lives in `editRegistry`: a
 * session switch unmounts this pane, and B-30 promises that loses nothing.
 */

/** Mirrors `EDIT_WRITE_MAX_BYTES` in src/main/fileEdit.ts. Checked here only on a PASTE
 *  (and by main on every save): counting the bytes of a whole buffer per keystroke is the
 *  kind of cost §05 measured this feature's limits to avoid. */
const SAVE_MAX_BYTES = 1024 * 1024

/** B-04 — one sentence per reason the ✎ is dark, in ordinary words. The `readOnly` values
 *  come back from `edit.open`; the `KOLOFT_*` ones are what it throws. */
function reasonSentence(readOnly: string | null, failure: string): string {
  if (failure.includes('KOLOFT_TOO_LARGE')) return 'Too large to edit here (limit 512 KB)'
  if (failure.includes('KOLOFT_BINARY')) return 'Not a text file'
  if (failure.includes('KOLOFT_NOT_FILE')) return 'Not a plain file'
  if (failure.includes('KOLOFT_GONE')) return 'This file is not there any more'
  if (failure) return 'Could not read this file'
  if (readOnly === 'notUtf8') return 'Not UTF-8 — editing would corrupt it'
  if (readOnly === 'mixedEol') return 'Mixed line endings — editing would rewrite every line'
  if (readOnly === 'noPerm') return 'Read-only file'
  if (readOnly === 'dirNotWritable') return 'The folder around it is not writable'
  return ''
}

/** B-03/B-04 — the notice when a file the user asked to EDIT cannot be opened for editing
 *  at all (too big, binary, not a plain file). The reason is the same one the ✎'s tooltip
 *  carries, so the two routes never explain the same file differently. */
export function editRefusal(failure: string): string {
  return 'Cannot edit this file — ' + (reasonSentence(null, failure) || 'unknown reason')
}

export interface EditProbe {
  /** the answer is in (a false here only means "still asking") */
  ready: boolean
  /** may this file be edited at all (B-04/B-05) */
  can: boolean
  /** the ✎'s tooltip: 'Edit', or why not */
  title: string
}

/**
 * B-04/B-05 — ask, for one file, whether the ✎ may light up.
 *
 * The probe is `edit.open` itself, so the answer is the real size cap and the real endings
 * check rather than a second guess at them in the renderer. Both toolbars
 * use this one hook, which is what keeps the file tab's ✎ and the reading area's ✎ saying
 * the same thing about the same file (§09 note 4).
 */
export function useEditProbe(path: string | null): EditProbe {
  const [probe, setProbe] = useState<EditProbe>({ ready: false, can: false, title: '' })
  useEffect(() => {
    if (!path) {
      setProbe({ ready: false, can: false, title: '' })
      return
    }
    let cancelled = false
    setProbe({ ready: false, can: false, title: '' })
    window.api.edit
      .open(path)
      .then((r) => {
        if (cancelled) return
        setProbe({
          ready: true,
          can: r.readOnly === null,
          title: r.readOnly === null ? 'Edit' : reasonSentence(r.readOnly, '')
        })
      })
      .catch((err: unknown) => {
        if (cancelled) return
        const msg = String((err as Error)?.message ?? '')
        setProbe({ ready: true, can: false, title: reasonSentence(null, msg) })
      })
    return () => {
      cancelled = true
    }
  }, [path])
  return probe
}

export interface EditPaneProps {
  /** the CONVERSATION TAB this buffer belongs to — the registry's owner key (D8) */
  ownerTab: string
  /** the panel tab inside it */
  tabId: string
  /** the panel just entered edit mode on this tab — take the focus once */
  focusNonce: number
  /** B-17 — a save landed, so the change set and the git letters have to catch up */
  onSaved: () => void
  /**
   * this buffer holds PROSE, not code. The note is a list of things a person wrote
   * for themselves, so the spell checker is welcome where the code editor turns it off.
   * And Tab writes two spaces at the caret instead of walking the focus away, because in
   * a list of notes Tab means "indent this line", not "leave this box". Off by default:
   * on a source file B-11 stands, Tab moves the focus.
   */
  prose?: boolean
  /**
   * this buffer saves itself: 600 ms after the last key, at once when the box loses
   * the focus, and at once if it goes away with unsaved text. It writes through the very
   * same call ⌘S makes, so there is one save path and not two. It never writes over an
   * unanswered conflict bar: the file moved under us and only the user can say which side
   * wins. Off by default: a source file is saved on purpose.
   */
  autosave?: boolean
}

export function EditPane({
  ownerTab,
  tabId,
  focusNonce,
  onSaved,
  prose = false,
  autosave = false
}: EditPaneProps): JSX.Element {
  const areaRef = useRef<HTMLTextAreaElement>(null)
  // the registry mutates in place, so a version counter is what tells React something moved
  const [, bump] = useReducer((n: number) => n + 1, 0)
  useEffect(() => subscribeDirty(bump), [])
  const entry = getEntry(ownerTab, tabId)

  const [pos, setPos] = useState({ line: 1, col: 1 })
  const [showConflict, setShowConflict] = useState(false)
  const [tooBig, setTooBig] = useState(false)

  const path = entry?.path ?? ''
  const text = entry?.text ?? ''
  const dirty = !!entry && entry.text !== entry.original

  /** B-10 — the caret's line and column, at most ten times a second. Every cursor move
   *  would otherwise walk the file from the top (§05: 2 MB per keypress on a big one). */
  const posTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const trackCaret = useCallback((): void => {
    if (posTimer.current) return
    posTimer.current = setTimeout(() => {
      posTimer.current = null
      const el = areaRef.current
      if (!el) return
      const value = el.value
      setPos(positionAt(buildLineIndex(value), el.selectionStart, value))
      setSelection(ownerTab, tabId, el.selectionStart, el.selectionEnd)
    }, 100)
  }, [ownerTab, tabId])
  useEffect(
    () => () => {
      if (posTimer.current) clearTimeout(posTimer.current)
    },
    []
  )

  /**
   * Push the registry's text into the DOM node when something OTHER than typing changed it
   * — a silent reload (B-15), the conflict bar's Reload, a Discard. Never on a keystroke:
   * the node is already right, and re-assigning `value` would move the caret to the end and
   * throw the undo history away.
   */
  const domText = useRef<string | null>(null)
  useLayoutEffect(() => {
    const el = areaRef.current
    if (!el || !entry) return
    if (domText.current === entry.text) return
    if (el.value !== entry.text) {
      const caret = Math.min(el.selectionStart, entry.text.length)
      el.value = entry.text
      el.setSelectionRange(caret, caret)
    }
    domText.current = entry.text
    trackCaret()
  }, [entry, entry?.text, trackCaret])

  // B-30 — a session switch unmounts this pane, so the caret comes back off the registry.
  // Mount-only: within a session the node itself is never unmounted (`visibility`), and
  // re-applying a stored caret on a later render would fight the user's own cursor.
  const mounted = useRef(false)
  useLayoutEffect(() => {
    const el = areaRef.current
    if (!el || mounted.current) return
    mounted.current = true
    const sel = getEntry(ownerTab, tabId)?.selection
    if (sel) el.setSelectionRange(sel.start, sel.end)
    trackCaret()
  }, [ownerTab, tabId, trackCaret])

  // entering edit mode puts the caret in the box, so ⌘V and typing land where the user
  // just clicked ✎ — and only then, never on a re-render
  const lastFocus = useRef(0)
  useEffect(() => {
    if (focusNonce === lastFocus.current) return
    lastFocus.current = focusNonce
    if (focusNonce) areaRef.current?.focus()
  }, [focusNonce])

  /**
   * the autosaving buffer writes itself, and this is the whole of it.
   *
   * `saveAuto` is the write: it goes through `saveTab`, which is the exact call ⌘S makes, so
   * there is one save path in this app and not a second one that could drift from it. It
   * asks `autosaveAllowed` first, every single time, because the answer changes while the
   * timer runs — a conflict bar can come up in those 600 ms, and writing over it is the one
   * thing that bar exists to stop.
   *
   * `armSave` is the wait. It is re-armed on every key, so the write lands 600 ms after the
   * LAST one rather than after each.
   */
  const [saving, setSaving] = useState(false)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const saveAuto = useCallback((): void => {
    if (!autosave) return
    if (saveTimer.current) {
      clearTimeout(saveTimer.current)
      saveTimer.current = null
    }
    const e = getEntry(ownerTab, tabId)
    const ok =
      !!e &&
      autosaveAllowed({
        dirty: isDirty(e.original, e.text),
        conflict: e.conflict,
        readOnly: e.readOnly
      })
    if (!ok) {
      setSaving(false)
      return
    }
    setSaving(true)
    void saveTab(ownerTab, tabId).then((r) => {
      setSaving(false)
      if (r === 'saved') onSaved()
    })
  }, [autosave, ownerTab, tabId, onSaved])

  const armSave = useCallback((): void => {
    if (!autosave) return
    const e = getEntry(ownerTab, tabId)
    if (
      !e ||
      !autosaveAllowed({
        dirty: isDirty(e.original, e.text),
        conflict: e.conflict,
        readOnly: e.readOnly
      })
    )
      return
    if (saveTimer.current) clearTimeout(saveTimer.current)
    setSaving(true)
    saveTimer.current = setTimeout(saveAuto, AUTOSAVE_DELAY_MS)
  }, [autosave, ownerTab, tabId, saveAuto])

  // going away with unsaved text is the last chance to write it, and the pane goes away a
  // lot: a session switch unmounts it. The ref is so this cleanup runs on unmount ONLY,
  // rather than every time the callback above is rebuilt.
  const leaving = useRef(saveAuto)
  leaving.current = saveAuto
  useEffect(
    () => () => {
      leaving.current()
    },
    []
  )

  /** everything typing does, in one place, so the prose Tab below can be typing too. */
  const takeInput = useCallback(
    (el: HTMLTextAreaElement, pasted: boolean): void => {
      domText.current = el.value
      setText(ownerTab, tabId, el.value)
      // N-01 — only a paste can add enough at once to matter, so only a paste pays for
      // counting the bytes
      if (pasted || tooBig) setTooBig(exceedsBytes(el.value, SAVE_MAX_BYTES))
      trackCaret()
      armSave()
    },
    [ownerTab, tabId, tooBig, trackCaret, armSave]
  )

  /**
   * B-20/B-22 — the file on disk, watched while this pane is mounted and read once on
   * mount: a session switch unmounts the pane and its watch, so a write that lands
   * meanwhile reaches nobody until the pane is back. `reconcileDisk` holds the decision.
   */
  useEffect(() => {
    if (!path) return
    window.api.fs.watchFile(path)
    const readDisk = (): void => {
      window.api.edit
        .open(path)
        .then((r) =>
          reconcileDisk(ownerTab, tabId, {
            text: r.text,
            stamp: { mtimeMs: r.mtimeMs, size: r.size }
          })
        )
        .catch(() => {
          /* gone, too big or binary for a moment — the save's own check is the real gate */
        })
    }
    readDisk()
    const off = window.api.fs.onFileChange((p, fp) => {
      if (p !== path) return
      const e = getEntry(ownerTab, tabId)
      if (!e) return
      // the event carries a stamp and no bytes: a dirty buffer is told so at once (the
      // diff view reads the text if it is opened); a clean one, or an event with no
      // stamp at all, needs the read first
      if (fp && e.text !== e.original) {
        reconcileDisk(ownerTab, tabId, { text: null, stamp: fp })
        return
      }
      readDisk()
    })
    return () => {
      off()
      window.api.fs.unwatchFile(path)
    }
  }, [path, ownerTab, tabId])

  /** the conflict view needs the disk's text; the save path already brought it back, the
   *  watcher path did not, so that one reads it when the view is opened */
  const openDiff = useCallback((): void => {
    setShowConflict(true)
    const e = getEntry(ownerTab, tabId)
    if (!e?.conflict || e.conflict.text !== null) return
    window.api.edit
      .open(e.path)
      .then((r) =>
        noteConflict(ownerTab, tabId, {
          text: r.text,
          stamp: { mtimeMs: r.mtimeMs, size: r.size },
          unreadable: false
        })
      )
      .catch(() => {
        // what landed is too big, or is not text: there is no difference to draw, and the
        // strip has to say that rather than leave a view waiting for bytes that never come
        const now = getEntry(ownerTab, tabId)
        if (!now?.conflict) return
        setShowConflict(false)
        noteConflict(ownerTab, tabId, {
          text: null,
          stamp: now.conflict.stamp,
          unreadable: true
        })
      })
  }, [ownerTab, tabId])

  /** take what is on disk and drop the typing (B-09: this cuts the undo history) */
  const reload = useCallback((): void => {
    const e = getEntry(ownerTab, tabId)
    if (!e) return
    window.api.edit
      .open(e.path)
      .then((r) => {
        applyDisk(ownerTab, tabId, r.text, { mtimeMs: r.mtimeMs, size: r.size })
        setShowConflict(false)
      })
      .catch((err: unknown) => {
        // Now reachable on purpose: a file that grew past the reading cap, or turned
        // binary, offers this button and cannot answer it. The strip stays up, which is the
        // honest state, but a button that looks broken has to say what happened.
        useStore.getState().showToast(editRefusal(String((err as Error)?.message ?? '')))
      })
  }, [ownerTab, tabId])

  /** the override, and the only caller of `force` anywhere (§03 figure 2) */
  const keepMine = useCallback((): void => {
    void saveTab(ownerTab, tabId, { force: true }).then((r) => {
      if (r !== 'saved') return
      setShowConflict(false)
      onSaved()
    })
  }, [ownerTab, tabId, onSaved])

  const conflict = entry?.conflict ?? null
  const diskText = conflict?.text
  const parsed = useMemo(
    () => (showConflict && typeof diskText === 'string' ? diffLines(diskText, text) : null),
    // `text` is read at the moment the view opens; the buffer cannot change under it,
    // because the conflict view covers the box it would be typed into
    [showConflict, diskText, text]
  )

  const saved = entry?.savedAt
  const savedLabel = saved ? new Date(saved).toLocaleTimeString('en-GB', { hour12: false }) : null

  return (
    <div className="wb-edit-pane">
      {entry?.readOnly && (
        <div className="ed-ro" role="status">
          {reasonSentence(entry.readOnly, '')}
        </div>
      )}

      {conflict && !showConflict && (
        /* while the difference is open the strip stands down: it floats over the pane
           (z-index 20, shared with the artifact's own notice) and its Dismiss button then
           sits exactly on top of the view's first control — measured, not guessed. */
        <div className="fp-stale ed-stale" role="status">
          <span className="fp-stale-msg">
            {conflict.unreadable ? 'Changed on disk (too large to compare)' : 'Changed on disk'}
          </span>
          {/* B-21 — the override lives inside the difference, so that nobody takes it
              without having seen it. When there IS no difference to see, that reasoning
              has nothing to protect and the choice comes back out here: otherwise a file
              that grew past the reading cap would leave the user with Reload as the only
              way out, i.e. throw your work away or keep it in memory for ever. */}
          {conflict.unreadable ? (
            <button className="fp-stale-btn" onClick={keepMine}>
              Keep mine
            </button>
          ) : (
            <button className="fp-stale-btn" onClick={openDiff}>
              Show diff
            </button>
          )}
          {/* B-09 — the warning belongs on the control, not in a paragraph nobody reads:
              both ways out of a conflict rewrite the box, and a rewrite cuts the undo
              history (measured). The strip has room for a tooltip and nothing more. */}
          <button
            className="fp-stale-btn plain"
            title="Take what is on disk. Your changes go, and undo cannot bring them back."
            onClick={reload}
          >
            Reload
          </button>
          <button
            className="fp-stale-x"
            title="Dismiss"
            aria-label="Dismiss"
            onClick={() => clearConflict(ownerTab, tabId)}
          >
            <LuX size={14} />
          </button>
        </div>
      )}

      <textarea
        ref={areaRef}
        className="ed-area"
        /* the spell checker and NOTHING else: autocorrect and auto-capitalise
           would rewrite what the user typed, and a note is often a list of lines that
           are not sentences. */
        spellCheck={prose}
        aria-label="File contents"
        readOnly={!!entry?.readOnly}
        /* B-11 — over CODE, Tab is NOT captured: it moves the focus, exactly as it does
           everywhere else in the app. Over prose it writes two spaces instead.
           B-07 — no reformatting of any kind on the way in or out. */
        defaultValue={text}
        onInput={(e) => {
          takeInput(e.currentTarget, (e.nativeEvent as InputEvent).inputType === 'insertFromPaste')
        }}
        onKeyDown={(e) => {
          // plain Tab only: Shift+Tab still walks the focus backwards, and a Tab with a
          // modifier belongs to whatever shortcut owns it
          if (!prose || e.key !== 'Tab') return
          if (e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) return
          const el = e.currentTarget
          if (el.readOnly) return
          e.preventDefault()
          // B-09 — the spaces go in the way the browser itself puts text in: `insertText`
          // keeps the box's own undo history, so ⌘Z right after a Tab takes the two spaces
          // back. Writing them with `setRangeText` instead THROWS that history away
          // (measured) — one Tab and every earlier keystroke becomes un-undoable, which is
          // the worst thing a note can do to someone typing into it.
          //
          // It also fires the box's own `input` event, so `onInput` above has already told
          // the registry about the new text — telling it a second time here would be the
          // same answer twice.
          if (document.execCommand('insertText', false, TAB_TEXT)) return
          // no `insertText` to be had: write the spaces by hand and hand the text over
          // ourselves, at the cost of the undo history
          const { caret } = insertTab(el.value, el.selectionStart, el.selectionEnd)
          el.setRangeText(TAB_TEXT, el.selectionStart, el.selectionEnd)
          el.setSelectionRange(caret, caret)
          takeInput(el, false)
        }}
        onBlur={saveAuto}
        onKeyUp={trackCaret}
        onClick={trackCaret}
        onSelect={trackCaret}
      />

      {showConflict && !conflict?.unreadable && (
        <div className="ed-conflict">
          <div className="ed-conflict-hd">
            <span>
              On disk vs. yours — <b>Keep mine</b> overwrites the file, <b>Reload</b> throws your
              changes away. Either one ends the undo history.
            </span>
            <button className="fp-stale-btn" onClick={keepMine}>
              Keep mine
            </button>
            <button className="fp-stale-btn plain" onClick={reload}>
              Reload
            </button>
            <button
              className="fp-stale-x"
              title="Close"
              aria-label="Close"
              onClick={() => setShowConflict(false)}
            >
              <LuX size={14} />
            </button>
          </div>
          <div className="ed-conflict-body">
            {parsed ? (
              <InlineDiff src={path} parsed={parsed} />
            ) : (
              <div className="code-state">Reading what is on disk…</div>
            )}
          </div>
        </div>
      )}

      <div className="ed-status">
        <span className="ed-pos">
          Ln {pos.line}, Col {pos.col}
        </span>
        <span className="ed-eol">{entry?.eol === 'crlf' ? 'CRLF' : 'LF'}</span>
        <span className="right">
          {tooBig && <span className="ed-warn">Over the 1 MB save limit</span>}
          {entry?.error && <span className="ed-warn">{entry.error}</span>}
          {/* while the buffer is writing itself there is no "unsaved" to warn about,
              only a wait; the ⌘S hint stays either way, because the key still works — in
              the note it writes the file at once instead of waiting out the 600 ms
              (App.tsx's `onSave` routes it by where the caret is). */}
          {saving ? (
            <span className="ed-saving">Saving…</span>
          ) : dirty ? (
            <span className="ed-dirty">● Unsaved</span>
          ) : savedLabel ? (
            <span className="ed-saved">Saved {savedLabel}</span>
          ) : null}
          <span>⌘S</span>
        </span>
      </div>
    </div>
  )
}
