import { useEffect, useRef, type JSX, type ReactNode } from 'react'
import type { ExtensionPermissionRequest } from '@shared/types'

/**
 * D7/§04 figure 4 — the one modal every extension question is asked in: a Web Store install,
 * a running extension's `chrome.permissions.request`, an uninstall. Never a native
 * dialog: an OS sheet says nothing about which extension is asking, and the e2e
 * discipline forbids one outright (BB-N01).
 *
 * Dismissing is always the negative answer — the caller is stopped inside its own call
 * until one comes back, so there is no third outcome.
 */
export function ExtensionModal({
  title,
  realm,
  message,
  confirmLabel,
  cancelLabel,
  children,
  onAnswer
}: {
  title: string
  realm: string
  message: string
  confirmLabel: string
  cancelLabel: string
  children?: ReactNode
  onAnswer: (confirmed: boolean) => void
}): JSX.Element {
  const cancel = (): void => onAnswer(false)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const answer = useRef(onAnswer)
  answer.current = onAnswer

  // the modal takes the keyboard on the way up: whatever had it (the terminal, an
  // address bar) would otherwise keep it, and a modal nothing can type into is a modal
  // Tab and Enter cannot reach either
  useEffect(() => cancelRef.current?.focus(), [])

  // one subscription for as long as the modal is up — the caller's handler is a fresh
  // closure on every render of whatever owns it
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      answer.current(false)
    }
    // capture: an Esc pressed while xterm has the focus never reaches a bubbling
    // listener — the terminal stops it on the way up
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  return (
    <div className="bmodal-backdrop ext-confirm" onMouseDown={cancel}>
      <div
        className="bmodal"
        role="dialog"
        aria-modal="true"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="bmodal-head">
          <span className="bmodal-origin">{title}</span>
          <span className="bmodal-realm">{realm}</span>
        </div>
        <div className="bmodal-body">
          <div className="bmodal-msg">{message}</div>
          {children}
        </div>
        <div className="bmodal-foot">
          <button className="mini" ref={cancelRef} aria-label={cancelLabel} onClick={cancel}>
            {cancelLabel}
          </button>
          <button className="btn-primary" aria-label={confirmLabel} onClick={() => onAnswer(true)}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}

/**
 * The two asks that reach the renderer from the platform itself: an install the Web Store
 * page started (figure 4 — the extension is not installed yet, and its summary is the version
 * and permissions the store offered), and a permission a running extension wants more of.
 */
export function ExtensionConfirm({
  request,
  onAnswer
}: {
  request: ExtensionPermissionRequest
  onAnswer: (id: string, granted: boolean) => void
}): JSX.Element {
  const install = request.kind === 'install'
  const asked = [...request.permissions, ...request.origins]
  return (
    <ExtensionModal
      title={request.name}
      realm={
        install ? ['Chrome Web Store', request.version].filter(Boolean).join(' · ') : 'Extension'
      }
      message={
        install
          ? asked.length > 0
            ? 'Install this extension? It asks for:'
            : 'Install this extension?'
          : 'This extension is asking for more access:'
      }
      confirmLabel={install ? 'Install' : 'Allow'}
      cancelLabel={install ? 'Cancel' : 'Deny'}
      onAnswer={(granted) => onAnswer(request.id, granted)}
    >
      {asked.length > 0 && (
        <ul className="ext-perms">
          {asked.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
    </ExtensionModal>
  )
}
