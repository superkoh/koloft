// ADR-0054
export interface AgentWords {
  anyCase: readonly string[]
  wholeWord: readonly string[]
  quoted: readonly string[]
}

export interface AgentManifest {
  id: string
  wordsThatNameMe: AgentWords
}
