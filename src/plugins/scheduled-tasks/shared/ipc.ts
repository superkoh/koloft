export const CHANNELS = {
  list: 'cron:list',
  save: 'cron:save',
  delete: 'cron:delete',
  setEnabled: 'cron:setEnabled',
  runNow: 'cron:runNow',
  skills: 'cron:skills',
  trusted: 'cron:trusted',
  state: 'cron:state',
  runStarted: 'cron:runStarted'
} as const

export interface RunStartedNews {
  tabId: string
  started: boolean
}
