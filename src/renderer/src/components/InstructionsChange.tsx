import { useLayoutEffect, useMemo, useRef, type JSX } from 'react'
import {
  CHANGE_THEM,
  KEEP_THEM,
  NOTHING_CHANGES_UNTIL_YOU_AGREE,
  changeSummary,
  type InstructionAskView
} from '@plugins/sessions/shared/instructionAsks'
import { IconClose } from '../icons'
import { diffLines } from '@shared/editDiff'
import { focusOnceNoDialogIsOpen } from '../dialogOpen'
import { InlineDiff } from './InlineDiff'
import '../inlineDiff.css'

export function instructionAskOf(
  asks: readonly InstructionAskView[],
  tabId: string
): InstructionAskView | undefined {
  return asks.find((a) => a.tabId === tabId)
}

export function InstructionsChangeLines({
  before,
  after
}: {
  before: string
  after: string
}): JSX.Element {
  const parsed = useMemo(() => diffLines(before, after), [before, after])
  return (
    <div className="instr-change" aria-label="The change">
      <InlineDiff src="instructions.txt" parsed={parsed} />
    </div>
  )
}

export function InstructionsAskDialog({
  ask,
  shown
}: {
  ask: InstructionAskView
  shown: boolean
}): JSX.Element {
  const keep = useRef<HTMLButtonElement>(null)
  useLayoutEffect(() => {
    if (shown && keep.current) return focusOnceNoDialogIsOpen(keep.current)
    return undefined
  }, [shown, ask.id])
  const answer = (agreed: boolean): void => window.api.instructionAsks.answer(ask.id, agreed)
  return (
    <div className="modal-backdrop in-session">
      <div
        className="modal secret-modal"
        role="dialog"
        aria-label="Change the instructions?"
        onKeyDown={(e) => {
          if (e.key !== 'Escape') return
          e.preventDefault()
          e.stopPropagation()
          answer(false)
        }}
      >
        <div className="modal-header">
          <span>Change the instructions?</span>
          <span className="modal-close" onClick={() => answer(false)} aria-label="Close">
            <IconClose size={16} />
          </span>
        </div>
        <div className="modal-body">
          <p className="field-hint">
            <b>{ask.by}</b> wants to change {ask.what}: {changeSummary(ask.before, ask.after)}.
          </p>
          <InstructionsChangeLines before={ask.before} after={ask.after} />
          <p className="field-hint">{NOTHING_CHANGES_UNTIL_YOU_AGREE}</p>
        </div>
        <div className="modal-foot">
          <button ref={keep} className="mini" onClick={() => answer(false)}>
            {KEEP_THEM}
          </button>
          <button className="btn-primary" onClick={() => answer(true)}>
            {CHANGE_THEM}
          </button>
        </div>
      </div>
    </div>
  )
}
