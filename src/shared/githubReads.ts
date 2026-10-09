export const GH_READS: Record<string, string[]> = {
  pr: ['view', 'list', 'checks', 'diff'],
  issue: ['view', 'list'],
  run: ['view', 'list']
}

// PLATFORM§32
export const GH_FLAGS = [
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

export const GH_READS_TEXT = Object.entries(GH_READS)
  .map(([noun, actions]) => `${noun} ${actions.join('|')}`)
  .join(', ')
