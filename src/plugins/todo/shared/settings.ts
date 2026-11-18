import { setting, type SettingKeys } from '@core/settings'
import { textsIn } from '@shared/workbenchState'

export const SETTINGS = {
  todoNotes: setting<Record<string, string>>({
    default: {},
    clean: textsIn,
    keptOnReset: true,
    writtenByMainOnly: true
  })
} satisfies SettingKeys
