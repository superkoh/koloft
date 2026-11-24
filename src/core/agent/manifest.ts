// ADR-0054
import type { CronEffort } from '@shared/efforts'

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

export interface NamedModel {
  id: string
  label: string
  notOnEveryAccount?: true
}

export const TASK_TIERS = ['very simple', 'normal', 'very hard'] as const
export type TaskTier = (typeof TASK_TIERS)[number]

export interface ModelPick {
  model: string
  effort: CronEffort
}

export interface OwnSetting {
  default: boolean
  keptOnReset: boolean
}

export interface AgentFlags {
  resumeCanWaitOnAQuestionBeforeAnySign: boolean
  conversationStartsAtFirstPrompt: boolean
  pasteKeepsItsLastLineFeeds: boolean
}

export interface AgentPureFunctions {
  effortsAModelTakes(model: string | undefined): readonly CronEffort[]
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
  modelEveryAccountTakes?: string
  normalTaskFamilyEveryAccountHas?: string
  namedModels: readonly NamedModel[]
  picksByTaskTier: Readonly<Record<TaskTier, ModelPick>>
  ownSettings: Readonly<Record<string, OwnSetting>>
  flags: AgentFlags
  pureFunctions: AgentPureFunctions
}
