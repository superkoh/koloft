export type SettingsPaneId =
  | 'welcome'
  | 'sessions'
  | 'accounts'
  | 'appearance'
  | 'shortcuts'
  | 'assist'
  | 'discord'
  | 'notifications'
  | 'extensions'
  | 'about'

export const SETTINGS_PANES: { id: SettingsPaneId; label: string; words: string[] }[] = [
  { id: 'welcome', label: 'Welcome', words: ['欢迎', '入门', 'getting started'] },
  { id: 'sessions', label: 'Sessions', words: ['会话设置'] },
  { id: 'accounts', label: 'Accounts', words: ['账号', '账户', 'token'] },
  {
    id: 'appearance',
    label: 'Appearance',
    words: ['外观', '字号', '字体', '主题', '深色', 'font']
  },
  { id: 'shortcuts', label: 'Shortcuts', words: ['快捷键', 'keyboard', 'hotkey'] },
  { id: 'assist', label: 'Assist', words: ['助手'] },
  { id: 'discord', label: 'Discord', words: ['机器人'] },
  { id: 'notifications', label: 'Notifications', words: ['通知', '提醒'] },
  { id: 'extensions', label: 'Extensions', words: ['扩展', '插件', 'plugin'] },
  { id: 'about', label: 'About', words: ['关于', '版本号', 'version'] }
]

export type PaletteActionKey =
  | 'new-session'
  | 'new-worktree-session'
  | 'add-workspace'
  | 'add-remote'
  | 'restart-session'
  | 'toggle-workbench'
  | 'toggle-sidebar'
  | 'restore-session'
  | 'scheduled-jobs'
  | 'open-settings'
  | 'check-update'

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
  {
    key: 'scheduled-jobs',
    label: 'Scheduled jobs…',
    words: ['定时任务', '计划任务', 'cron'],
    actsOnCurrent: true
  },
  { key: 'open-settings', label: 'Settings…', keys: '⌘,', words: ['设置', '偏好', 'preferences'] },
  {
    key: 'check-update',
    label: 'Check for updates…',
    words: ['检查更新', '更新', '升级', '新版本', 'upgrade']
  },
  ...SETTINGS_PANES.map((p): PaletteFeature => ({
    key: `settings-${p.id}`,
    label: `Settings ▸ ${p.label}`,
    words: p.words,
    pane: p.id
  }))
]

export const ROUTABLE_FEATURES = PALETTE_FEATURES.filter((f) => !f.actsOnCurrent)
