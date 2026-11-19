import { fill, type PluginUi } from '@core/ui'
import { WORKBENCH_PART, WORKSPACE_GIT_PART } from '@renderer/slots'
import { CountsMark, GithubSection, hasGithub } from './counts'
import { fitGithubCounts } from './headFit'
import { useWorkbenchPart } from './workbench'

export const ui: PluginUi = {
  fills: [
    fill(WORKSPACE_GIT_PART, {
      shows: hasGithub,
      Mark: CountsMark,
      fit: fitGithubCounts,
      Section: GithubSection
    }),
    fill(WORKBENCH_PART, useWorkbenchPart)
  ]
}
