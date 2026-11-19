import { fill, type PluginUi } from '@core/ui'
import { GITHUB_BUTTON_PART, GITHUB_HINT } from './hint'
import {
  ISSUE_LAUNCH,
  PART_HINT,
  WORKBENCH_PART,
  WORKSPACE_GIT_PART,
  WORKTREE_ITEMS
} from '@renderer/slots'
import { CountsMark, GithubSection, hasGithub } from './counts'
import { fitGithubCounts } from './headFit'
import { useWorkbenchPart } from './workbench'
import { issueLaunch, useWorktreeItems } from './worktreeItems'

export const ui: PluginUi = {
  fills: [
    fill(WORKSPACE_GIT_PART, {
      shows: hasGithub,
      Mark: CountsMark,
      fit: fitGithubCounts,
      Section: GithubSection
    }),
    fill(WORKBENCH_PART, useWorkbenchPart),
    fill(PART_HINT, {
      id: 'github',
      part: GITHUB_BUTTON_PART,
      selector: '.wb-gh',
      words: GITHUB_HINT
    }),
    fill(WORKTREE_ITEMS, useWorktreeItems),
    fill(ISSUE_LAUNCH, issueLaunch)
  ]
}
