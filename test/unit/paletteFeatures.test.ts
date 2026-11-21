import { describe, it, expect } from 'vitest'
import { PALETTE_FEATURES, SETTINGS_PANES } from '@shared/paletteFeatures'

describe('the ⌘P list of features', () => {
  it('lists the actions in one fixed order, then a Settings ▸ entry for each page of the Settings window', () => {
    expect(PALETTE_FEATURES.map((f) => f.key)).toEqual([
      'new-session',
      'new-worktree-session',
      'add-workspace',
      'add-remote',
      'restart-session',
      'toggle-workbench',
      'toggle-sidebar',
      'restore-session',
      'scheduled-jobs',
      'open-settings',
      'check-update',
      ...SETTINGS_PANES.map((p) => `settings-${p.id}`)
    ])
  })

  it('Scheduled jobs… is found by its Chinese words and cron, and acts on the current workspace', () => {
    expect(PALETTE_FEATURES.find((f) => f.key === 'scheduled-jobs')).toEqual({
      key: 'scheduled-jobs',
      label: 'Scheduled jobs…',
      words: ['定时任务', '计划任务', 'cron'],
      actsOnCurrent: true
    })
  })
})
