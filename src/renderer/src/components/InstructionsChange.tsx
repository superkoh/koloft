import { useMemo, type JSX } from 'react'
import type { InstructionsChange } from '@core/ownerInstructions'
import { diffLines } from './editDiff'
import { InlineDiff } from './InlineDiff'
import '../inlineDiff.css'

export const UNDO_TAKES_BACK_ONLY_THIS =
  'Undo takes back only this change; an earlier change stays.'
export const CHANGE_UNDONE = 'Change undone'
export const CHANGE_UNDONE_SHOWS_MS = 4000

const lines = (n: number, what: string): string => `${n} line${n === 1 ? '' : 's'} ${what}`

export function changeSummary({ before, after }: InstructionsChange): string {
  const { rows } = diffLines(before, after)
  const added = rows.filter((r) => r.kind === 'add').length
  const removed = rows.filter((r) => r.kind === 'del').length
  if (!rows.some((r) => r.kind === 'ctx') && added && removed) return 'Whole text replaced'
  return [added && lines(added, 'added'), removed && lines(removed, 'removed')]
    .filter(Boolean)
    .join(', ')
}

export const changedBy = ({ by, at }: InstructionsChange): string =>
  `changed by ${by} · ${new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })}`

export function InstructionsChangeLines({ change }: { change: InstructionsChange }): JSX.Element {
  const parsed = useMemo(() => diffLines(change.before, change.after), [change])
  return (
    <div className="instr-change" aria-label="The change">
      <InlineDiff src="instructions.txt" parsed={parsed} />
    </div>
  )
}
