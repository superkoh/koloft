import { ensureMinimumFn } from '../../../main/cliMinimums'

// CC§16
export const MIN_CLAUDE_VERSION = '2.1.293'

export const ENSURE_CLAUDE_MINIMUM_FN = ensureMinimumFn({
  tool: 'claude',
  product: 'Claude Code',
  min: MIN_CLAUDE_VERSION,
  update: '"$1" update',
  byHand: 'Run "claude update" yourself'
})
