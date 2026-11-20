import { useLayoutEffect, useMemo, useRef, type JSX } from 'react'
import type { InstructionAskView } from '@plugins/sessions/shared/instructionAsks'
import { IconClose } from '../icons'
import { diffLines } from './editDiff'
import { InlineDiff } from './InlineDiff'
import '../inlineDiff.css'

export function instructionAskOf(
  asks: readonly InstructionAskView[],
  tabId: string
): InstructionAskView | undefined {
  return asks.find((a) => a.tabId === tabId)
}

const lines = (n: number, what: string): string => `${n} line${n === 1 ? '' : 's'} ${what}`

export function changeSummary(before: string, after: string): string {
  const { rows } = diffLines(before, after)
  const added = rows.filter((r) => r.kind === 'add').length
  const removed = rows.filter((r) => r.kind === 'del').length
  if (!rows.some((r) => r.kind === 'ctx') && added && removed) return 'the whole text replaced'
  const counted = [added && lines(added, 'added'), removed && lines(removed, 'removed')]
  return counted.filter(Boolean).join(', ') || 'a small change'
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
    if (shown) keep.current?.focus()
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
          <p className="field-hint">
            {ask.forEveryWorkspace
              ? 'Nothing changes until you agree. Sessions started afterwards, in every workspace that does not leave them out, follow the new text.'
              : 'Nothing changes until you agree. Sessions started afterwards follow the new text.'}
          </p>
        </div>
        <div className="modal-foot">
          <button ref={keep} className="mini" onClick={() => answer(false)}>
            Don&apos;t change
          </button>
          <button className="btn-primary" onClick={() => answer(true)}>
            Change them
          </button>
        </div>
      </div>
    </div>
  )
}
