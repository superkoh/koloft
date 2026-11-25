// ADR-0054
import type { CronEffort } from '@shared/efforts'
import type { ModelAndEffort } from '../assistModels'
import type { SettingKey } from '../settings'

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

export interface EnvNames {
  named: readonly string[]
  startingWith: readonly string[]
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

export type OwnSetting = Pick<SettingKey<boolean>, 'default' | 'keptOnReset'>

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

export interface AgentPureFunctions {
  effortsAModelTakes(model: string | undefined): readonly CronEffort[]
}

export interface AccountKindFacts {
  id: string
  keychainServiceSuffix: string
  isASignInFolder: boolean
  signsInThroughABrowser: boolean
  storesAPastedKeyItself: boolean
  takesAnEndpoint: boolean
}

export interface AgentManifest {
  id: string
  name: string
  productName: string
  maker: string
  command: string
  nodePackageFolderNames: readonly string[]
  wordsThatNameMe: AgentWords
  skillPrefix: string
  questionToolName: string
  instructionFileNames: readonly string[]
  trustQuestion: string
  textItsMessagesCannotHold?: string
  ownLogFolderNames: readonly string[]
  atTopOfSessionFolder: AtTopOfSessionFolder
  envOfItsSessionThatMisleadsWhatStartsInside: EnvNames
  modelEveryAccountTakes?: string
  normalTaskFamilyEveryAccountHas?: string
  namedModels: readonly NamedModel[]
  picksByTaskTier: Readonly<Record<TaskTier, ModelPick>>
  smallJobModels: Readonly<Record<SmallJobKind, ModelAndEffort>>
  ownSettings: Readonly<Record<string, OwnSetting>>
  slotFills: Readonly<Record<string, string>>
  slotAdditions: Readonly<Record<string, string>>
  flags: AgentFlags
  pureFunctions: AgentPureFunctions
  accountKinds: readonly AccountKindFacts[]
}
