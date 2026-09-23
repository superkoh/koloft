import { useEffect, useRef, useState, type JSX } from 'react'
import { useStore } from '../store'
import { unsavedBody, UNSAVED_TITLE } from '../closeSession'
import { removeJobsNote } from '../unsavedGuard'

export function UnsavedDialog(): JSX.Element | null {
  const prompt = useStore((s) => s.unsavedPrompt)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const discardRef = useRef<HTMLButtonElement>(null)
  const saveRef = useRef<HTMLButtonElement>(null)
  const [saveInFlight, setSaveInFlight] = useState(false)

  useEffect(() => {
    if (prompt) {
      setSaveInFlight(false)
      saveRef.current?.focus()
    }
  }, [prompt])

  useEffect(() => {
    if (!prompt) return
    const onKey = (e: globalThis.KeyboardEvent): void => {
      if (e.key === 'Escape') {
        if (saveInFlight) return
        useStore.getState().setUnsavedPrompt(null)
        prompt.onCancel()
        return
      }
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
      const row = [cancelRef.current, discardRef.current, saveRef.current]
      const at = row.indexOf(document.activeElement as HTMLButtonElement)
      const next = at < 0 ? row.length - 1 : at + (e.key === 'ArrowRight' ? 1 : -1)
      row[Math.max(0, Math.min(row.length - 1, next))]?.focus()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [prompt, saveInFlight])

  if (!prompt) return null
  const body = [unsavedBody(prompt.files), removeJobsNote(prompt.jobs ?? 0)]
    .filter(Boolean)
    .join(' ')
  const cancel = (): void => {
    if (saveInFlight) return
    useStore.getState().setUnsavedPrompt(null)
    prompt.onCancel()
  }
  const discard = (): void => {
    useStore.getState().setUnsavedPrompt(null)
    prompt.onDiscard()
  }
  const save = (): void => {
    setSaveInFlight(true)
    void Promise.resolve(prompt.onSave()).finally(() => setSaveInFlight(false))
  }

  return (
    <div className="modal-backdrop" onClick={cancel}>
      <div className="modal unsaved-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">{UNSAVED_TITLE}</div>
        <div className="modal-body">
          <p className="field-hint">{body}</p>
        </div>
        <div className="modal-foot">
          <button ref={cancelRef} className="mini" disabled={saveInFlight} onClick={cancel}>
            Cancel
          </button>
          <button
            ref={discardRef}
            className="mini danger"
            disabled={saveInFlight}
            onClick={discard}
          >
            Discard
          </button>
          <button ref={saveRef} className="btn-primary" disabled={saveInFlight} onClick={save}>
            Save &amp; close
          </button>
        </div>
      </div>
    </div>
  )
}
