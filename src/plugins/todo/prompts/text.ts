import type { TextBlock } from '@core/plugin'

// MUSE§12
const SORT_OUT_THE_TO_DOS =
  'When the owner asks you to sort out the to-dos, or what waits on them, run koloft todo and do what it prints.'

export const TODO_NOTICE = `Koloft got a new command after this conversation began: koloft todo. ${SORT_OUT_THE_TO_DOS} There is nothing to answer now.`

export const TEXT: readonly TextBlock[] = [
  {
    slot: 'owners-ai-folder-koloft',
    text: ' koloft todo gathers what waits on the owner in every workspace: each workspace with its to-do note, the sessions asking the owner, done with their turn or closed with work left, the open pull requests (whose they are, checks, size, which issues they close), and the tools (MCP servers) each agent can reach. koloft todo note <workspace> prints a workspace\'s to-do note, which says where its to-dos are kept and which count; koloft todo note <workspace> -- "<note>" saves it. Workspaces of one GitHub repository share one note; an empty note removes it. koloft todo file <workspace> <file> prints one of the instruction or TODO files koloft todo lists for a workspace, also from a workspace on another machine.'
  },
  { slot: 'owners-ai-koloft', text: ` ${SORT_OUT_THE_TO_DOS}` },
  { slot: 'away-digest-more', text: '; koloft todo lists them all' }
]
