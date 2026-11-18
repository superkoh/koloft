import { setting, type SettingKeys } from '@core/settings'

export const SETTINGS = {
  // PLATFORM§17
  browserControl: setting<boolean>({ default: true, clean: (raw) => raw as boolean })
} satisfies SettingKeys
