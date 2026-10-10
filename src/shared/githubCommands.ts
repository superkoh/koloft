export const GH_READS: Record<string, string[]> = {
  pr: ['view', 'list', 'checks', 'diff'],
  issue: ['view', 'list'],
  run: ['view', 'list']
}

// PLATFORM§32
export const GH_READ_FLAGS = [
  '--json',
  '--repo',
  '--state',
  '--limit',
  '--search',
  '--label',
  '--author',
  '--assignee',
  '--base',
  '--head',
  '--branch',
  '--status',
  '--workflow',
  '--commit',
  '--job',
  '--comments',
  '--name-only',
  '--required',
  '--log-failed'
]

export const GH_ISSUE_CREATE_FLAGS = ['--title', '--body', '--body-file', '--label', '--repo']

export const GH_READS_TEXT = Object.entries(GH_READS)
  .map(([noun, actions]) => `${noun} ${actions.join('|')}`)
  .join(', ')

export const GH_ISSUE_CREATE_TEXT =
  'issue create --title <title> --body <text> [--label <name>] [--repo <owner>/<name>]'
