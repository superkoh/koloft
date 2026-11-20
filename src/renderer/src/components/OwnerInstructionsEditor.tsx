import { useLayoutEffect, useState, type JSX, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { IconAiStart } from '../icons'
import { useStore } from '../store'
import { isComposing } from '../keys'
import { InstructionsChangeLines } from './InstructionsChange'
import { bytesLeft, cleanInstructions, instructionsBytes } from '@core/ownerInstructions'
import '../commandPalette.css'

export type OwnerInstructionsSaved = { ok: true } | { ok: false; error: string; inUse?: string }

const COULD_NOT_SAVE = 'Koloft could not save the instructions.'

export function useEscapeCloses(close: () => void): void {
  // PLATFORM§25
  useLayoutEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })
}

export function OwnerInstructionsEditor({
  title,
  placeholder,
  status,
  inUse,
  maxBytes,
  save: saveText,
  savedToast,
  onClose
}: {
  title: string
  placeholder: string
  status: string
  inUse: string
  maxBytes: number
  save(text: string, opened: string): Promise<OwnerInstructionsSaved>
  savedToast: string
  onClose(): void
}): JSX.Element {
  const showToast = useStore((s) => s.showToast)
  const [opened, setOpened] = useState(inUse)
  const [text, setText] = useState(opened)
  const [error, setError] = useState('')
  const [changed, setChanged] = useState<{ before: string; after: string } | null>(null)
  const left = maxBytes - instructionsBytes(cleanInstructions(text))
  useEscapeCloses(onClose)
  const save = async (): Promise<void> => {
    if (left < 0) return
    setChanged(null)
    const r = await saveText(text, opened).catch((): OwnerInstructionsSaved => ({
      ok: false,
      error: COULD_NOT_SAVE
    }))
    if (!r.ok) {
      setError(r.error)
      if (r.inUse === undefined) return
      setChanged({ before: opened, after: r.inUse })
      setOpened(r.inUse)
      return
    }
    onClose()
    showToast(savedToast)
  }
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (isComposing(e)) return e.stopPropagation()
    if (e.key !== 'Enter' || !e.metaKey) return
    e.preventDefault()
    void save()
  }
  // ADR-0013
  return createPortal(
    <div className="modal-backdrop palette-top" onClick={onClose}>
      <div
        className="modal palette"
        role="dialog"
        aria-label="Instructions"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="pal-count">{title}</div>
        <div className="pal-ask">
          <span className="pal-glyph">
            <IconAiStart size={18} />
          </span>
          <textarea
            autoFocus
            className="pal-field"
            rows={3}
            spellCheck={false}
            autoComplete="off"
            aria-label="Instructions"
            placeholder={placeholder}
            value={text}
            onChange={(e) => {
              setText(e.target.value)
              if (!changed) setError('')
            }}
            onKeyDown={onKeyDown}
          />
        </div>
        {error && <div className="pal-status field-hint bad">{error}</div>}
        {changed && <InstructionsChangeLines {...changed} />}
        <div className="pal-status">{status}</div>
        <div className="pal-bar">
          <span className="pal-tips">
            {left >= 0 ? (
              bytesLeft(left)
            ) : (
              <span className="field-hint bad">{bytesLeft(left)}</span>
            )}
          </span>
          <button className="pal-pill" onClick={onClose}>
            Cancel <span className="k">Esc</span>
          </button>
          <button className="pal-pill go" disabled={left < 0} onClick={() => void save()}>
            Save <span className="k">⌘⏎</span>
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
