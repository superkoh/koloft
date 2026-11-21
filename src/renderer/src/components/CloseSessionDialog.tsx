import { useEffect, useRef, useState, type JSX, type RefObject } from 'react'
import { useStore } from '../store'
import {
  closeConfirmBody,
  CLOSE_CONFIRM_TITLE,
  FULL_CLOSE_CHECKING,
  FULL_CLOSE_TITLE,
  fullCloseBody,
  fullCloseRefusedBody
} from '../closeSession'
import { requestCloseTab } from '../closeFlow'

function useDialogKeys(
  open: boolean,
  buttons: RefObject<HTMLButtonElement | null>[],
  onEscape: () => void
): void {
  useEffect(() => {
    if (!open) return
    const onKey = (e: globalThis.KeyboardEvent): void => {
      if (e.key === 'Escape') {
        onEscape()
        return
      }
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
      const row = buttons.map((b) => b.current).filter((b) => b && !b.disabled)
      const at = row.indexOf(document.activeElement as HTMLButtonElement)
      const next = at < 0 ? 0 : at + (e.key === 'ArrowRight' ? 1 : -1)
      row[Math.max(0, Math.min(row.length - 1, next))]?.focus()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })
}

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

  const dismiss = (): void => {
    if (saveInFlight) return
    useStore.getState().setCloseConfirm(null)
  }
  useDialogKeys(!!confirm, [cancelRef, closeRef, saveRef], dismiss)

  if (!confirm) return null
  const unsaved = confirm.unsaved
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

export function FullCloseDialog(): JSX.Element | null {
  const shown = useStore((s) => s.fullClose)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const goRef = useRef<HTMLButtonElement>(null)
  const opened = shown?.tabId

  useEffect(() => {
    if (opened) cancelRef.current?.focus()
  }, [opened])

  const dismiss = (): void => useStore.getState().setFullClose(null)
  useDialogKeys(!!shown, [cancelRef, goRef], dismiss)

  if (!shown) return null
  const { left } = shown
  const refused = !!left?.length
  const go = (): void => {
    dismiss()
    if (refused) requestCloseTab(shown.tabId)
    else void window.api.sessions.closeFully(shown.sessionId)
  }

  return (
    <div className="modal-backdrop" onClick={dismiss}>
      <div className="modal lifecycle-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">{FULL_CLOSE_TITLE}</div>
        <div className="modal-body">
          <p className="field-hint">
            {refused ? fullCloseRefusedBody(shown.title) : fullCloseBody(shown.title, shown.status)}
          </p>
          {left === null && <p className="field-hint">{FULL_CLOSE_CHECKING}</p>}
          {left?.map((what) => (
            <p key={what} className="field-hint close-left">
              {what}
            </p>
          ))}
        </div>
        <div className="modal-foot">
          <button ref={cancelRef} className="mini" onClick={dismiss}>
            Cancel
          </button>
          <button ref={goRef} className="mini danger" disabled={left === null} onClick={go}>
            {refused ? 'Close tab only' : 'Close for good'}
          </button>
        </div>
      </div>
    </div>
  )
}
