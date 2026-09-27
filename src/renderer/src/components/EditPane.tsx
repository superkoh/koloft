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
import { EDIT_OPEN_MAX_BYTES, EDIT_WRITE_MAX_BYTES, sizeLabel } from '@shared/editLimits'

const CARET_READOUT_THROTTLE_MS = 100

function reasonSentence(readOnly: string | null, failure: string): string {
  if (failure.includes('KOLOFT_TOO_LARGE'))
    return `Too large to edit here (limit ${sizeLabel(EDIT_OPEN_MAX_BYTES)})`
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

export function editRefusal(failure: string): string {
  return 'Cannot edit this file — ' + (reasonSentence(null, failure) || 'unknown reason')
}

export interface EditProbe {
  ready: boolean
  can: boolean
  title: string
}

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
  ownerTab: string
  tabId: string
  focusNonce: number
  onSaved: () => void
  prose?: boolean
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
  const [, bump] = useReducer((n: number) => n + 1, 0)
  useEffect(() => subscribeDirty(bump), [])
  const entry = getEntry(ownerTab, tabId)

  const [pos, setPos] = useState({ line: 1, col: 1 })
  const [showConflict, setShowConflict] = useState(false)
  const [tooBig, setTooBig] = useState(false)

  const path = entry?.path ?? ''
  const text = entry?.text ?? ''
  const dirty = !!entry && entry.text !== entry.original

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
    }, CARET_READOUT_THROTTLE_MS)
  }, [ownerTab, tabId])
  useEffect(
    () => () => {
      if (posTimer.current) clearTimeout(posTimer.current)
    },
    []
  )

  // ADR-0018
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

  const mounted = useRef(false)
  useLayoutEffect(() => {
    const el = areaRef.current
    if (!el || mounted.current) return
    mounted.current = true
    const sel = getEntry(ownerTab, tabId)?.selection
    if (sel) el.setSelectionRange(sel.start, sel.end)
    trackCaret()
  }, [ownerTab, tabId, trackCaret])

  const lastFocus = useRef(0)
  useEffect(() => {
    if (focusNonce === lastFocus.current) return
    lastFocus.current = focusNonce
    if (focusNonce) areaRef.current?.focus()
  }, [focusNonce])

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

  const leaving = useRef(saveAuto)
  leaving.current = saveAuto
  useEffect(
    () => () => {
      leaving.current()
    },
    []
  )

  const takeInput = useCallback(
    (el: HTMLTextAreaElement, pasted: boolean): void => {
      domText.current = el.value
      setText(ownerTab, tabId, el.value)
      if (pasted || tooBig) setTooBig(exceedsBytes(el.value, EDIT_WRITE_MAX_BYTES))
      trackCaret()
      armSave()
    },
    [ownerTab, tabId, tooBig, trackCaret, armSave]
  )

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
        .catch(() => {})
    }
    readDisk()
    const off = window.api.fs.onFileChange((p, fp) => {
      if (p !== path) return
      const e = getEntry(ownerTab, tabId)
      if (!e) return
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
        useStore.getState().showToast(editRefusal(String((err as Error)?.message ?? '')))
      })
  }, [ownerTab, tabId])

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
        <div className="fp-stale ed-stale" role="status">
          <span className="fp-stale-msg">
            {conflict.unreadable ? 'Changed on disk (too large to compare)' : 'Changed on disk'}
          </span>
          {conflict.unreadable ? (
            <button className="fp-stale-btn" onClick={keepMine}>
              Keep mine
            </button>
          ) : (
            <button className="fp-stale-btn" onClick={openDiff}>
              Show diff
            </button>
          )}
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

      {/* ADR-0018 */}
      <textarea
        ref={areaRef}
        className="ed-area"
        spellCheck={prose}
        aria-label="File contents"
        readOnly={!!entry?.readOnly}
        defaultValue={text}
        onInput={(e) => {
          takeInput(e.currentTarget, (e.nativeEvent as InputEvent).inputType === 'insertFromPaste')
        }}
        onKeyDown={(e) => {
          if (!prose || e.key !== 'Tab') return
          if (e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) return
          const el = e.currentTarget
          if (el.readOnly) return
          e.preventDefault()
          if (document.execCommand('insertText', false, TAB_TEXT)) return
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
          {tooBig && (
            <span className="ed-warn">Over the {sizeLabel(EDIT_WRITE_MAX_BYTES)} save limit</span>
          )}
          {entry?.error && <span className="ed-warn">{entry.error}</span>}
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
