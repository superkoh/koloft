import type { TextBlock } from '@core/plugin'

export const TEXT: readonly TextBlock[] = [
  {
    slot: 'route-worktree-picks',
    text: '  {"issue": <number>} when the message names an issue number,\n'
  },
  {
    slot: 'butler-koloft',
    text: ` Before opening a GitHub issue, first look for one already open with koloft gh issue list --repo <owner>/<name> --search "<words in English>"; then write the title and body in English, plainly, like a developer's note, even when the owner writes to you in another language.`
  }
]
