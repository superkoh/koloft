export type AppPaneId =
  | 'welcome'
  | 'sessions'
  | 'accounts'
  | 'usage'
  | 'appearance'
  | 'shortcuts'
  | 'assist'
  | 'plugins'
  | 'notifications'
  | 'extensions'
  | 'about'

export type SettingsPaneId = string

export interface SettingsPane {
  id: SettingsPaneId
  label: string
  words: readonly string[]
}

export const PLUGINS_PANE_NAME = 'Plugins'

export const PANES_BEFORE_PLUGIN_PAGES: readonly (SettingsPane & { id: AppPaneId })[] = [
  { id: 'welcome', label: 'Welcome', words: ['欢迎', '入门', 'getting started'] },
  { id: 'sessions', label: 'Sessions', words: ['会话设置'] },
  { id: 'accounts', label: 'Accounts', words: ['账号', '账户', 'token'] },
  { id: 'usage', label: 'Usage', words: ['用量', '花费', '费用', 'cost', 'spend'] },
  {
    id: 'appearance',
    label: 'Appearance',
    words: ['外观', '字号', '字体', '主题', '深色', 'font']
  },
  { id: 'shortcuts', label: 'Shortcuts', words: ['快捷键', 'keyboard', 'hotkey'] },
  { id: 'assist', label: 'Assist', words: ['助手'] },
  { id: 'plugins', label: PLUGINS_PANE_NAME, words: ['插件', 'plugin', '功能开关'] }
]

export const PANES_AFTER_PLUGIN_PAGES: readonly (SettingsPane & { id: AppPaneId })[] = [
  { id: 'notifications', label: 'Notifications', words: ['通知', '提醒'] },
  { id: 'extensions', label: 'Extensions', words: ['扩展'] },
  { id: 'about', label: 'About', words: ['关于', '版本号', 'version'] }
]

export const APP_PANES = [...PANES_BEFORE_PLUGIN_PAGES, ...PANES_AFTER_PLUGIN_PAGES]

export function settingsPaneName(id: AppPaneId): string {
  return `Settings ▸ ${APP_PANES.find((p) => p.id === id)!.label}`
}

export function pluginPageName(plugin: string): string {
  return `${settingsPaneName('plugins')} ▸ ${plugin}`
}
