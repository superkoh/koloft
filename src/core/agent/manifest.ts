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

export interface AgentManifest {
  id: string
  wordsThatNameMe: AgentWords
  ownLogFolderNames: readonly string[]
  atTopOfSessionFolder: AtTopOfSessionFolder
}
