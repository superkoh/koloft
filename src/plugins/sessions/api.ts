import type { BackendId } from '@shared/types'
import { composePrompt } from '@core/prompt'
import {
  PICKED_FLAGS,
  PICK_FOR_THE_TASK,
  WAITING_QUESTION_TOOL,
  withProjectRules
} from './prompts/text'

export { PICKED_FLAGS, PICK_FOR_THE_TASK, WAITING_QUESTION_TOOL, withProjectRules }
export {
  SlashCommands,
  toCaller,
  type SlashReplyTo,
  type SlashTarget,
  type SlashResult
} from './main/slashCommands'
export { RepliesOwed, type ReplyListener } from './main/repliesOwed'
export {
  HandOver,
  type HandOverDeps,
  type QuietMarks,
  type Recipient,
  type Words
} from './main/handOver'
export type { SendResult, StartResult, StartSpec } from './main/sendAndStart'
export {
  placedRows,
  resolveWorkspace,
  workspaceLabel,
  type PinnedWorkspace,
  type PlacedRow
} from './main/placedRows'
export { GITHUB_NOT_ASKED, type MergedHeads } from '../../main/sessionClose'

export const koloftPrompt = (backend: BackendId, rules?: string): string =>
  composePrompt('session', {
    agent: backend,
    values: { 'project-rules': withProjectRules(rules, '') }
  })
