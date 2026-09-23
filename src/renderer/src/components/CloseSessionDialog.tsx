import { useEffect, useRef, useState, type JSX } from 'react'
import { useStore } from '../store'
import { closeConfirmBody, CLOSE_CONFIRM_TITLE } from '../closeSession'

/**
 * the lifecycle contract D3 §3.1 — the one question ⌘W asks: closing a session that is mid-turn
 * or holding a permission prompt kills the process, so the keyboard is stacked against
 * doing it by accident (default focus, ⏎ and Esc are all Cancel; Close needs a click
 * or a deliberate → ⏎).
 *
 * file-edit B-25 grows a third button for the session that is running AND holding
 * unsaved files: Cancel / Discard & close / Save & close, one question instead of two
 * in a row. The default focus stays on Cancel even then — unlike the plain
 * unsaved-changes dialog next door, this button row still ends a running process, and
 * that is what the default has to protect against.
 */
export function CloseSessionDialog(): JSX.Element | null {
  const confirm = useStore((s) => s.closeConfirm)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const saveRef = useRef<HTMLButtonElement>(null)
  // a save can take a moment; a second click would kill the session twice over
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (confirm) {
      setBusy(false)
      cancelRef.current?.focus()
    }
  }, [confirm])

  useEffect(() => {
    if (!confirm) return
    const onKey = (e: globalThis.KeyboardEvent): void => {
      if (e.key === 'Escape') {
        // a save already in flight cannot be taken back — Esc here would clear the
        // dialog and then close the session anyway when it finished
        if (busy) return
        useStore.getState().setCloseConfirm(null)
        return
      }
      // the buttons are the whole dialog, so ←/→ walk them (⏎ then activates whichever
      // has the focus — the only way to reach Close from the keyboard)
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
      const row = [cancelRef.current, closeRef.current, saveRef.current].filter((b) => b)
      const at = row.indexOf(document.activeElement as HTMLButtonElement)
      const next = at < 0 ? 0 : at + (e.key === 'ArrowRight' ? 1 : -1)
      row[Math.max(0, Math.min(row.length - 1, next))]?.focus()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [confirm, busy])

  if (!confirm) return null
  const unsaved = confirm.unsaved
  const dismiss = (): void => {
    if (busy) return
    useStore.getState().setCloseConfirm(null)
  }
  const proceed = (): void => {
    const st = useStore.getState()
    st.setCloseConfirm(null)
    // D3: the pty dies, the row stays — SIGHUP's SessionEnd reason is outside the
    // membership whitelist (D1/E6), so the session simply turns cold.
    st.closeTab(confirm.tabId)
  }
  // B-25: throw the typing away first, then it is exactly the close above
  const discardClose = (): void => {
    unsaved?.discard()
    proceed()
  }
  // B-25: a file that did not reach the disk cancels the close outright — the buffer is
  // still the only copy of that work, and killing the session would take it with it. The
  // question comes down either way: a refused save has brought the offending tab forward,
  // and this modal would be sitting on top of the conflict it is telling them to resolve.
  const saveClose = (): void => {
    if (!unsaved) return
    setBusy(true)
    void unsaved.save().then((ok) => {
      setBusy(false)
      if (ok) proceed()
      else useStore.getState().setCloseConfirm(null)
    })
  }

  return (
    <div className="modal-backdrop" onClick={dismiss}>
      <div className="modal lifecycle-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">{CLOSE_CONFIRM_TITLE}</div>
        <div className="modal-body">
          <p className="field-hint">
            {closeConfirmBody(confirm.title, confirm.status, unsaved?.files ?? [])}
          </p>
        </div>
        <div className="modal-foot">
          <button ref={cancelRef} className="mini" disabled={busy} onClick={dismiss}>
            Cancel
          </button>
          <button
            ref={closeRef}
            className="mini danger"
            disabled={busy}
            onClick={unsaved ? discardClose : proceed}
          >
            {unsaved ? 'Discard & close' : 'Close'}
          </button>
          {unsaved && (
            <button ref={saveRef} className="btn-primary" disabled={busy} onClick={saveClose}>
              Save &amp; close
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
