import { useEffect, useRef, type JSX, type ReactNode } from 'react'
import type { ExtensionPermissionRequest } from '@shared/types'

const CAPTURE_BEFORE_XTERM = true

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

  useEffect(() => cancelRef.current?.focus(), [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      answer.current(false)
    }
    window.addEventListener('keydown', onKey, CAPTURE_BEFORE_XTERM)
    return () => window.removeEventListener('keydown', onKey, CAPTURE_BEFORE_XTERM)
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
