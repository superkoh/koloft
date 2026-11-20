import type { TextBlock } from '@core/plugin'

export const TEXT: readonly TextBlock[] = [
  { slot: 'koloft-skill-or-list', text: 'gather what waits on the owner (butler only)' },
  {
    slot: 'koloft-help-todo',
    text: `

TO-DOS

Only for the butler and the helpers it starts in its own folder.

koloft todo
    Gather what waits on the owner in every workspace, and print how to sort it out with the owner: each workspace with its to-do note, the sessions asking the owner, done with their turn or closed with work left, the open pull requests (whose they are, checks, size, which issues they close), and the tools (MCP servers) each agent can reach.

koloft todo note <workspace> [-- "<note>"]
    Print a workspace's to-do note, or save it: where its to-dos are kept and which count. Workspaces of one GitHub repository share one note. An empty note removes it.
    Example: koloft todo note koloft -- "To-dos are GitHub issues assigned to octo. Pull requests: opened by octo or asking octo to review."

koloft todo file <workspace> <file>
    Print one of the instruction or TODO files koloft todo lists for a workspace, also from a workspace on another machine.
    Example: koloft todo file koloft CLAUDE.md`
  }
]
