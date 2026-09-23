import { useEffect, useRef, useState, type JSX } from 'react'
import { useStore } from '../store'
import { closeConfirmBody, CLOSE_CONFIRM_TITLE } from '../closeSession'

export function CloseSessionDialog(): JSX.Element | null {
  const confirm = useStore((s) => s.closeConfirm)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const saveRef = useRef<HTMLButtonElement>(null)
  const [saveInFlight, setSaveInFlight] = useState(false)

  useEffect(() => {
    if (confirm) {
      setSaveInFlight(false)
      cancelRef.current?.focus()
    }
  }, [confirm])

  useEffect(() => {
    if (!confirm) return
    const onKey = (e: globalThis.KeyboardEvent): void => {
      if (e.key === 'Escape') {
        if (saveInFlight) return
        useStore.getState().setCloseConfirm(null)
        return
      }
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
      const row = [cancelRef.current, closeRef.current, saveRef.current].filter((b) => b)
      const at = row.indexOf(document.activeElement as HTMLButtonElement)
      const next = at < 0 ? 0 : at + (e.key === 'ArrowRight' ? 1 : -1)
      row[Math.max(0, Math.min(row.length - 1, next))]?.focus()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [confirm, saveInFlight])

  if (!confirm) return null
  const unsaved = confirm.unsaved
  const dismiss = (): void => {
    if (saveInFlight) return
    useStore.getState().setCloseConfirm(null)
  }
  const proceed = (): void => {
    const st = useStore.getState()
    st.setCloseConfirm(null)
    st.closeTab(confirm.tabId)
  }
  const discardClose = (): void => {
    unsaved?.discard()
    proceed()
  }
  const saveClose = (): void => {
    if (!unsaved) return
    setSaveInFlight(true)
    void unsaved.save().then((ok) => {
      setSaveInFlight(false)
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
          <button ref={cancelRef} className="mini" disabled={saveInFlight} onClick={dismiss}>
            Cancel
          </button>
          <button
            ref={closeRef}
            className="mini danger"
            disabled={saveInFlight}
            onClick={unsaved ? discardClose : proceed}
          >
            {unsaved ? 'Discard & close' : 'Close'}
          </button>
          {unsaved && (
            <button
              ref={saveRef}
              className="btn-primary"
              disabled={saveInFlight}
              onClick={saveClose}
            >
              Save &amp; close
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
