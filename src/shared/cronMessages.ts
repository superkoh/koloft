/** What Koloft says when a scheduled job does not add up (§7.5).
 *
 *  Shared because the same rules run twice, on purpose: the form checks them while a
 *  person types, and `CronRunner.save` checks them again before anything is written,
 *  since a job can also arrive from a hand-edited file or a call that never went
 *  through the dialog. Two copies of these sentences would drift, and then the dialog
 *  and the answer it gets back would disagree about the very same job.
 *
 *  Every line is what one would say out loud: what to do, not what went wrong. */
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
