import type { BackendId } from '@shared/types'
import { composePrompt } from '@core/prompt'
import {
  PICKED_FLAGS,
  PICK_FOR_THE_TASK,
  WAITING_QUESTION_TOOL,
  withProjectRules
} from './prompts/text'

export { PICKED_FLAGS, PICK_FOR_THE_TASK, WAITING_QUESTION_TOOL, withProjectRules }
export { FROM_KOLOFT } from './main/crossSessionMessage'
export {
  SlashCommands,
  toCaller,
  type SlashReplyTo,
  type SlashTarget,
  type SlashResult
} from './main/slashCommands'
export { RepliesOwed, type ReplyListener } from './main/repliesOwed'
export { ANSWER_NOT_TAKEN, askFromClaude, askFromCodex, type KoloftAsk } from './main/dialog'
export type { SessionsStarted } from './main/start'
export {
  folderOf,
  startBeside,
  type BesideDeps,
  type BesideResult,
  type BesideSpec,
  type SessionTabs,
  type TabPlace
} from './main/sessionTabs'
export { HandOver, type HandOverDeps, type HandingMarks, type Recipient } from './main/handOver'
export type { SendResult, StartResult, StartSpec } from './main/sendAndStart'
export {
  placedRows,
  resolveWorkspace,
  workspaceLabel,
  type PinnedWorkspace,
  type PlacedRow
} from './main/placedRows'
export { GITHUB_NOT_ASKED, type MergedHeads, type WorkLeft } from './main/sessionClose'
export {
  savedFromTheDialog,
  workspaceBlock,
  workspaceInstructionsPart
} from './main/workspaceInstructions'
export {
  everyWorkspaceBlock,
  ownerPartsOf,
  savedByTheOwner as everyWorkspaceSavedByTheOwner
} from './main/everyWorkspaceInstructions'
export type { InstructionsBlock } from './main/instructionsVerb'
export { InstructionAsks } from './main/instructionAsks'
export type {
  InstructionAsk,
  InstructionAskEnd,
  InstructionAskListener
} from './main/instructionAsks'
export {
  CHANGE_THEM,
  INSTRUCTIONS_CHANGED_MEANWHILE,
  KEEP_THEM,
  nothingChangesUntilYouAgree,
  changeSummary
} from './shared/instructionAsks'

export const koloftPrompt = (backend: BackendId, rules?: string): string =>
  composePrompt('session', {
    agent: backend,
    values: { 'project-rules': withProjectRules(rules, '') }
  })
