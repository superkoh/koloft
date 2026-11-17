import type { BackendId } from '@shared/types'
import { composePrompt } from '@core/prompt'
import {
  PICKED_FLAGS,
  PICK_FOR_THE_TASK,
  WAITING_QUESTION_TOOL,
  withProjectRules
} from './prompts/text'

export { PICKED_FLAGS, PICK_FOR_THE_TASK, WAITING_QUESTION_TOOL, withProjectRules }
export { RepliesOwed, type ReplyListener } from './main/repliesOwed'

export const koloftPrompt = (backend: BackendId, rules?: string): string =>
  composePrompt('session', {
    agent: backend,
    values: { 'project-rules': withProjectRules(rules, '') }
  })
