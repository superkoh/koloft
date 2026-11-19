import { createContext, useContext } from 'react'

const PLUGIN_PAGE = 'plugin:'

export const pluginPane = (plugin: string): string => PLUGIN_PAGE + plugin

export const pluginOfPane = (pane: string): string | null =>
  pane.startsWith(PLUGIN_PAGE) ? pane.slice(PLUGIN_PAGE.length) : null

export const SettingsGo = createContext<(pane: string) => void>(() => {})

export const useSettingsGo = (): ((pane: string) => void) => useContext(SettingsGo)
