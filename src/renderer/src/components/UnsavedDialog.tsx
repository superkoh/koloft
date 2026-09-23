import { useEffect, useRef, useState, type JSX } from 'react'
import { useStore } from '../store'
import { unsavedBody, UNSAVED_TITLE } from '../closeSession'
import { removeJobsNote } from '../unsavedGuard'

/**
 * file-edit §03 figure 3 — the one question every route that would destroy unsaved
 * edits asks: closing a file tab (B-24), quitting Koloft (B-26), and closing an idle
 * session (B-25). The three answers are the prompt's own callbacks, because those
 * routes end in different places and only the caller knows which.
 *
 * The default focus sits on "Save & close", which is a DELIBERATE departure from
 * `CloseSessionDialog` next door. That dialog defaults to Cancel because its Close
 * kills a running process — a rare answer with an expensive mistake behind it. Here the
 * everyday answer is Save, and parking the focus at the far end of the row would
 * punish the right answer every single time. Esc is still Cancel, and Discard — the one
 * button that loses work — is still only reachable by moving there on purpose.
 */
export function UnsavedDialog(): JSX.Element | null {
  const prompt = useStore((s) => s.unsavedPrompt)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const discardRef = useRef<HTMLButtonElement>(null)
  const saveRef = useRef<HTMLButtonElement>(null)
  // a save can take a moment; a second click on it would run the whole route twice
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (prompt) {
      setBusy(false)
      saveRef.current?.focus()
    }
  }, [prompt])

  useEffect(() => {
    if (!prompt) return
    const onKey = (e: globalThis.KeyboardEvent): void => {
      if (e.key === 'Escape') {
        // a save already in flight cannot be taken back — Esc here would clear the
        // dialog and then let the finished save go through anyway
        if (busy) return
        useStore.getState().setUnsavedPrompt(null)
        prompt.onCancel()
        return
      }
      // ←/→ walk the row, so ⏎ (the browser's own activation of a focused button) can
      // reach any of the three
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
      const row = [cancelRef.current, discardRef.current, saveRef.current]
      const at = row.indexOf(document.activeElement as HTMLButtonElement)
      const next = at < 0 ? row.length - 1 : at + (e.key === 'ArrowRight' ? 1 : -1)
      row[Math.max(0, Math.min(row.length - 1, next))]?.focus()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [prompt, busy])

  if (!prompt) return null
  // one of the routes — removing a workspace — deletes scheduled jobs on the same
  // click, so its question says that too. Closing a tab or quitting deletes no job and
  // sends no count, so the line is simply not there.
  const body = [unsavedBody(prompt.files), removeJobsNote(prompt.jobs ?? 0)]
    .filter(Boolean)
    .join(' ')
  const cancel = (): void => {
    if (busy) return
    useStore.getState().setUnsavedPrompt(null)
    prompt.onCancel()
  }
  const discard = (): void => {
    useStore.getState().setUnsavedPrompt(null)
    prompt.onDiscard()
  }
  // Cancel and Discard dismiss from here; Save never does, because only the caller knows
  // whether the thing it was guarding actually went ahead. Every caller does take the
  // question down, including on a refused save: the difference and the two ways out of it
  // live on the file's own tab, which the caller brings forward, and this modal would be
  // sitting on top of it. The sentence is the caller's too — there is nowhere to put one
  // here.
  const save = (): void => {
    setBusy(true)
    void Promise.resolve(prompt.onSave()).finally(() => setBusy(false))
  }

  return (
    <div className="modal-backdrop" onClick={cancel}>
      <div className="modal unsaved-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">{UNSAVED_TITLE}</div>
        <div className="modal-body">
          <p className="field-hint">{body}</p>
        </div>
        <div className="modal-foot">
          <button ref={cancelRef} className="mini" disabled={busy} onClick={cancel}>
            Cancel
          </button>
          <button ref={discardRef} className="mini danger" disabled={busy} onClick={discard}>
            Discard
          </button>
          <button ref={saveRef} className="btn-primary" disabled={busy} onClick={save}>
            Save &amp; close
          </button>
        </div>
      </div>
    </div>
  )
}
