import { settingsPages } from '@core/settings'
import { PLUGINS } from '@plugins/list'
import {
  PANES_AFTER_PLUGIN_PAGES,
  PANES_BEFORE_PLUGIN_PAGES,
  PLUGINS_PANE_NAME,
  type SettingsPane,
  type SettingsPaneId
} from './settingsPanes'

export type { SettingsPaneId } from './settingsPanes'

export const PLUGIN_SETTINGS_PAGES = settingsPages(PLUGINS)

export const SETTINGS_PANES: readonly SettingsPane[] = [
  ...PANES_BEFORE_PLUGIN_PAGES,
  ...PLUGIN_SETTINGS_PAGES.map(({ id, label, words }) => ({
    id,
    label: `${PLUGINS_PANE_NAME} ▸ ${label}`,
    words
  })),
  ...PANES_AFTER_PLUGIN_PAGES
]

export type CorePaletteAction =
  | 'new-session'
  | 'new-worktree-session'
  | 'add-workspace'
  | 'add-remote'
  | 'restart-session'
  | 'toggle-workbench'
  | 'toggle-sidebar'
  | 'restore-session'
  | 'open-settings'
  | 'check-update'

export const PLUGIN_PALETTE_ACTIONS = ['scheduled-jobs'] as const

export type PluginPaletteAction = (typeof PLUGIN_PALETTE_ACTIONS)[number]

export type PaletteActionKey = CorePaletteAction | PluginPaletteAction

export interface PaletteFeature {
  key: PaletteActionKey | `settings-${SettingsPaneId}`
  label: string
  keys?: string
  words: string[]
  pane?: SettingsPaneId
  actsOnCurrent?: true
}

export const PALETTE_FEATURES: PaletteFeature[] = [
  { key: 'new-session', label: 'New session…', keys: '⌘N', words: ['新会话', '新建会话'] },
  {
    key: 'new-worktree-session',
    label: 'New worktree session…',
    keys: '⇧⌘N',
    words: ['新 worktree']
  },
  {
    key: 'add-workspace',
    label: 'Add workspace…',
    keys: '⇧⌘O',
    words: ['添加工作区', '加工作区', '打开文件夹', 'open folder']
  },
  { key: 'add-remote', label: 'Add remote workspace…', words: ['远程工作区', 'ssh'] },
  {
    key: 'restart-session',
    label: 'Restart session',
    keys: '⇧⌘R',
    words: ['重启会话'],
    actsOnCurrent: true
  },
  {
    key: 'toggle-workbench',
    label: 'Toggle Workbench',
    keys: '⇧⌘B',
    words: ['工作台', '右侧面板']
  },
  { key: 'toggle-sidebar', label: 'Toggle sidebar', keys: '⌘B', words: ['侧栏', '侧边栏'] },
  {
    key: 'restore-session',
    label: 'Restore session…',
    words: ['恢复会话', '找回会话', '旧会话'],
    actsOnCurrent: true
  },
  ...PLUGINS.flatMap((plugin) =>
    (plugin.ui ?? []).flatMap((entry): PaletteFeature[] =>
      entry.place === 'palette-item'
        ? [
            {
              key: entry.id as PluginPaletteAction,
              label: entry.label,
              words: [...entry.words],
              ...(entry.actsOnCurrent && { actsOnCurrent: entry.actsOnCurrent })
            }
          ]
        : []
    )
  ),
  { key: 'open-settings', label: 'Settings…', keys: '⌘,', words: ['设置', '偏好', 'preferences'] },
  {
    key: 'check-update',
    label: 'Check for updates…',
    words: ['检查更新', '更新', '升级', '新版本', 'upgrade']
  },
  ...SETTINGS_PANES.map((p): PaletteFeature => ({
    key: `settings-${p.id}`,
    label: `Settings ▸ ${p.label}`,
    words: [...p.words],
    pane: p.id
  }))
]

export const ROUTABLE_FEATURES = PALETTE_FEATURES.filter((f) => !f.actsOnCurrent)
