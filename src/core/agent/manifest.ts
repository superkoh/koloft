// ADR-0054
import type { ModelAndEffort } from '../assistModels'

export interface AgentWords {
  anyCase: readonly string[]
  wholeWord: readonly string[]
  quoted: readonly string[]
}

export interface AtTopOfSessionFolder {
  internalNames: readonly string[]
  internalNameEndings: readonly string[]
  foldersMadeEmptyAhead: readonly string[]
}

export interface AgentFlags {
  resumeCanWaitOnAQuestionBeforeAnySign: boolean
  conversationStartsAtFirstPrompt: boolean
  pasteKeepsItsLastLineFeeds: boolean
  passedOnMessageShowsAsFromAnotherSession: boolean
  commandsItRunsCanHaveATerminalOfTheirOwn: boolean
  runsCommandsInASandboxWhereSudoCannotStart: boolean
  questionToolTakesNoOptionDescriptions: boolean
}

export type SmallJobKind = 'smallAndQuick' | 'judgesAReply' | 'picksFromAList'

export interface AgentManifest {
  id: string
  name: string
  productName: string
  maker: string
  wordsThatNameMe: AgentWords
  skillPrefix: string
  questionToolName: string
  instructionFileNames: readonly string[]
  trustQuestion: string
  ownLogFolderNames: readonly string[]
  atTopOfSessionFolder: AtTopOfSessionFolder
  slotFills: Readonly<Record<string, string>>
  slotAdditions: Readonly<Record<string, string>>
  smallJobModels: Readonly<Record<SmallJobKind, ModelAndEffort>>
  flags: AgentFlags
}
