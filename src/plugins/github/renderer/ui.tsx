import { fill, type PluginUi } from '@core/ui'
import { WORKSPACE_GIT_PART } from '@renderer/slots'
import { CountsMark, GithubSection, hasGithub } from './counts'
import { fitGithubCounts } from './headFit'

export const ui: PluginUi = {
  fills: [
    fill(WORKSPACE_GIT_PART, {
      shows: hasGithub,
      Mark: CountsMark,
      fit: fitGithubCounts,
      Section: GithubSection
    })
  ]
}
