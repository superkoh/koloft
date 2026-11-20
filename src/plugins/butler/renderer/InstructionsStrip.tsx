import { useLayoutEffect, useState, type JSX, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { IconAiStart, IconClose } from '@renderer/icons'
import { useStore } from '@renderer/store'
import { isComposing } from '@renderer/keys'
import { InstructionsChangeLines } from '@renderer/components/InstructionsChange'
import { bytesLeft, cleanInstructions, instructionsBytes } from '@core/ownerInstructions'
import { INSTRUCTIONS_MAX_BYTES, instructionsOf } from '../shared/instructions'
import type { InstructionsSaveResult } from '../shared/ipc'
import { isButlerTab } from './butlerTabs'
import { openButler, useButler } from './state'
import '@renderer/commandPalette.css'
import './butler.css'

const whenItTakesEffect = (name: string): string =>
  `${name} uses it from the next fresh conversation (on Muse, from the next start).`

const COULD_NOT_SAVE = 'Koloft could not save the instructions.'

export function InstructionsStrip(): JSX.Element | null {
  const opened = useButler((s) => s.openedTab)
  const editing = useButler((s) => s.editingInstructions)
  const onButler = useStore(
    (s) => !!s.activeTabId && isButlerTab(s.sessions, opened, s.activeTabId)
  )
  const name = useStore((s) => s.settings.butler.name)
  if (!onButler) return null
  return (
    <div className="wb-bar butler-strip">
      <span className="wb-title">
        <span className="nm">{name}</span>
        <span className="dir">&nbsp;· Butler</span>
      </span>
      <button className="mini" onClick={() => useButler.setState({ askingFresh: true })}>
        Start a fresh conversation
      </button>
      <button
        className="mini"
        aria-pressed={editing}
        onClick={() => useButler.setState({ editingInstructions: true })}
      >
        Instructions
      </button>
    </div>
  )
}

function useEscapeCloses(close: () => void): void {
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

export function InstructionsDialog(): JSX.Element | null {
  const open = useButler((s) => s.editingInstructions)
  return open ? <InstructionsEditor /> : null
}

function InstructionsEditor(): JSX.Element {
  const butler = useStore((s) => s.settings.butler)
  const showToast = useStore((s) => s.showToast)
  const [opened, setOpened] = useState(() => instructionsOf(butler))
  const [text, setText] = useState(opened)
  const [error, setError] = useState('')
  const [changed, setChanged] = useState<{ before: string; after: string } | null>(null)
  const left = INSTRUCTIONS_MAX_BYTES - instructionsBytes(cleanInstructions(text))
  const close = (): void => useButler.setState({ editingInstructions: false })
  useEscapeCloses(close)
  const save = async (): Promise<void> => {
    if (left < 0) return
    setChanged(null)
    const r = await window.api.butler
      .saveInstructions(text, opened)
      .catch((): InstructionsSaveResult => ({ ok: false, error: COULD_NOT_SAVE }))
    if (!r.ok) {
      setError(r.error)
      if (r.inUse === undefined) return
      setChanged({ before: opened, after: r.inUse })
      setOpened(r.inUse)
      return
    }
    close()
    showToast(`Instructions saved. ${whenItTakesEffect(butler.name)}`)
  }
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (isComposing(e)) return e.stopPropagation()
    if (e.key !== 'Enter' || !e.metaKey) return
    e.preventDefault()
    void save()
  }
  // ADR-0013
  return createPortal(
    <div className="modal-backdrop palette-top" onClick={close}>
      <div
        className="modal palette"
        role="dialog"
        aria-label="Instructions"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="pal-count">{`Instructions for ${butler.name} · written by you`}</div>
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
            placeholder={`What should ${butler.name} always know or do? One rule a line.`}
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
        <div className="pal-status">
          {`${butler.name} and the helpers it starts follow this. ${whenItTakesEffect(butler.name)}`}
        </div>
        <div className="pal-bar">
          <span className="pal-tips">
            {left >= 0 ? (
              bytesLeft(left)
            ) : (
              <span className="field-hint bad">{bytesLeft(left)}</span>
            )}
          </span>
          <button className="pal-pill" onClick={close}>
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

export function FreshConversationDialog(): JSX.Element | null {
  const open = useButler((s) => s.askingFresh)
  return open ? <FreshConversationAsk /> : null
}

function FreshConversationAsk(): JSX.Element {
  const name = useStore((s) => s.settings.butler.name)
  const close = (): void => useButler.setState({ askingFresh: false })
  useEscapeCloses(close)
  const start = (): void => {
    close()
    void openButler(true)
  }
  // ADR-0013
  return createPortal(
    <div className="modal-backdrop" onClick={close}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          Start a fresh conversation?
          <span className="modal-close" onClick={close} aria-label="Close">
            <IconClose size={16} />
          </span>
        </div>
        <div className="modal-body">
          <div className="field-hint">
            {`${name} ends this conversation and starts a new one, which reads your instructions as they are now.`}
          </div>
        </div>
        <div className="modal-foot">
          <button className="mini" onClick={close}>
            Cancel
          </button>
          <button autoFocus className="btn-primary" onClick={start}>
            Start fresh
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
