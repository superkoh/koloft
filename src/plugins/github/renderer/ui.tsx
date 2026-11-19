import { fill, type PluginUi } from '@core/ui'
import { ISSUE_LAUNCH, WORKBENCH_PART, WORKSPACE_GIT_PART, WORKTREE_ITEMS } from '@renderer/slots'
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
    fill(WORKTREE_ITEMS, useWorktreeItems),
    fill(ISSUE_LAUNCH, issueLaunch)
  ]
}
