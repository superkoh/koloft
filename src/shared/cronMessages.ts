export const CRON_SAVE_MESSAGES = {
  nameEmpty: 'Give the job a name.',
  nameDash: 'The name cannot start with a dash.',
  nameNoWord: 'Use at least one letter or digit in the name.',
  nameLong: 'Keep the name under 80 characters.',
  taskEmpty: 'Say what to run.',
  taskDash: 'The text cannot start with a dash.',
  taskLong: 'Keep the text under 4096 characters.',
  workspace: 'The workspace path is not valid.',
  days: 'Pick at least one day.',
  time: 'Use a time like 09:00.',
  every: 'Use a whole number from 1 to 720 minutes or 1 to 24 hours.',
  model: 'Use letters, digits, dots, colons, dashes or underscores.'
} as const

export type CronSaveMessageKey = keyof typeof CRON_SAVE_MESSAGES
