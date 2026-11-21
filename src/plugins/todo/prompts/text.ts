import type { TextBlock } from '@core/plugin'

// MUSE§12
const SORT_OUT_THE_TO_DOS =
  'When the owner asks you to sort out the to-dos, or what waits on them, run koloft todo and do what it prints.'

export const TODO_NOTICE = `Koloft got a new command after this conversation began: koloft todo. ${SORT_OUT_THE_TO_DOS} There is nothing to answer now.`

export const TEXT: readonly TextBlock[] = [
  { slot: 'owners-ai-koloft', text: ` ${SORT_OUT_THE_TO_DOS}` },
  { slot: 'away-digest-more', text: '; koloft todo lists them all' }
]
