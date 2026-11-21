import type { JSX } from 'react'
import { createPortal } from 'react-dom'
import { IconClose } from '@renderer/icons'
import { useStore } from '@renderer/store'
import {
  OwnerInstructionsEditor,
  useEscapeCloses
} from '@renderer/components/OwnerInstructionsEditor'
import { INSTRUCTIONS_MAX_BYTES, instructionsOf } from '../shared/instructions'
import { isButlerTab } from './butlerTabs'
import { openButler, useButler } from './state'
import './butler.css'

const whenItTakesEffect = (name: string): string =>
  `${name} uses it from the next fresh conversation (on Muse, from the next start).`

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

export function InstructionsDialog(): JSX.Element | null {
  const open = useButler((s) => s.editingInstructions)
  const butler = useStore((s) => s.settings.butler)
  if (!open) return null
  return (
    <OwnerInstructionsEditor
      title={`Instructions for ${butler.name} · written by you`}
      placeholder={`What should ${butler.name} always know or do? One rule a line.`}
      status={`${butler.name} and the helpers it starts follow this. ${whenItTakesEffect(butler.name)}`}
      inUse={instructionsOf(butler)}
      maxBytes={INSTRUCTIONS_MAX_BYTES}
      save={(text, opened) => window.api.butler.saveInstructions(text, opened)}
      savedToast={`Instructions saved. ${whenItTakesEffect(butler.name)}`}
      onClose={() => useButler.setState({ editingInstructions: false })}
    />
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
