import { setting, type SettingKeys } from '@core/settings'
import {
  cleanInstructionsOfWorkspaces,
  type InstructionsOfWorkspaces
} from './workspaceInstructions'

export const SETTINGS = {
  workspaceInstructions: setting<InstructionsOfWorkspaces>({
    default: {},
    clean: cleanInstructionsOfWorkspaces,
    keptOnReset: true,
    writtenByMainOnly: true
  })
} satisfies SettingKeys
