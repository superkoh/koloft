// ADR-0054
import type { IconType } from 'react-icons'
import type { AgentManifest } from './manifest'
import type { AgentId, AgentSettingValues } from './registry'
import type { AgentUsageUi } from './usageShape'

export interface AgentOwnSettingRow<Setting extends string = keyof AgentSettingValues> {
  setting: Setting
  title: string
  note: string
}

interface SignInButtonWords {
  button: string
  buttonTitle: string
  pasteButton: string
}

export type AgentSignInUi = SignInButtonWords &
  ({ inATab: false } | { inATab: true; hintEnd: string })

export interface PasteFormWords {
  title: string
  placeholder: string
  hint: string
}

export interface AgentAccountsUi {
  emptyLine: string
  ownSettingRows: readonly AgentOwnSettingRow[]
  signIn: AgentSignInUi
  pasteForms: Readonly<Record<string, PasteFormWords>>
  baseUrlPlaceholders: Readonly<Record<string, string>>
}

type KindsOf<Manifest extends AgentManifest> = Manifest['accountKinds'][number]

export type AgentAccountsUiOf<Manifest extends AgentManifest> = Omit<
  AgentAccountsUi,
  'ownSettingRows' | 'pasteForms' | 'baseUrlPlaceholders'
> & {
  ownSettingRows: readonly AgentOwnSettingRow<
    Extract<keyof Manifest['ownSettings'], keyof AgentSettingValues>
  >[]
  pasteForms: Readonly<Record<KindsOf<Manifest>['id'], PasteFormWords>>
  baseUrlPlaceholders: Readonly<
    Record<Extract<KindsOf<Manifest>, { takesAnEndpoint: true }>['id'], string>
  >
}

export interface AgentUi {
  id: AgentId
  mark: IconType
  accounts: AgentAccountsUi
  usage: AgentUsageUi
}
