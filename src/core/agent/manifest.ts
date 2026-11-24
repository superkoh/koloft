// ADR-0054
export interface AgentWords {
  anyCase: readonly string[]
  wholeWord: readonly string[]
  quoted: readonly string[]
}

export interface HiddenAtTopOfScratchpad {
  named: readonly string[]
  nameEndingIn: readonly string[]
  foldersWhileEmpty: readonly string[]
}

export interface AgentManifest {
  id: string
  wordsThatNameMe: AgentWords
  folderNamesNotWatched: readonly string[]
  hiddenAtTopOfScratchpad: HiddenAtTopOfScratchpad
}
