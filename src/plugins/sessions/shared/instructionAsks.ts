import { diffLines } from '@shared/editDiff'

export interface InstructionAskView {
  id: string
  tabId: string
  by: string
  what: string
  before: string
  after: string
}

export const NOTHING_CHANGES_UNTIL_YOU_AGREE =
  'Nothing changes until you agree. Sessions started afterwards follow the new text.'
export const KEEP_THEM = "Don't change"
export const CHANGE_THEM = 'Change them'
export const INSTRUCTIONS_CHANGED_MEANWHILE =
  'The instructions changed meanwhile, so nothing changed.'

const lines = (n: number, what: string): string => `${n} line${n === 1 ? '' : 's'} ${what}`

export function changeSummary(before: string, after: string): string {
  const { rows } = diffLines(before, after)
  const added = rows.filter((r) => r.kind === 'add').length
  const removed = rows.filter((r) => r.kind === 'del').length
  if (!rows.some((r) => r.kind === 'ctx') && added && removed) return 'the whole text replaced'
  const counted = [added && lines(added, 'added'), removed && lines(removed, 'removed')]
  return counted.filter(Boolean).join(', ') || 'a small change'
}
