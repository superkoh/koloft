// ADR-0054
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
}

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
  flags: AgentFlags
}
