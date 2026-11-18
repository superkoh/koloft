import { fill, type PluginUi } from '@core/ui'
import {
  GLOBAL_NOTE,
  LANDING_AFTER_CLOSE,
  PALETTE_HAND_OFF,
  ROW_MARK,
  WORKSPACE_CLAIM
} from '@renderer/slots'
import { isButlersWorkspace } from './butlerTabs'
import { BUTLER_RENAME, BUTLER_ROW_PART, BUTLER_SET_UP } from '../plugin'
import { ButlerRow, RenameButlerDialog } from './ButlerRow'
import { ButlerSetUpDialog } from './SetUpDialog'
import { butlerLanding, useButlerShowsGlobalNote } from './landing'
import { StartedByButler, useStartedByButler } from './startedBy'

export const ui: PluginUi = {
  parts: {
    [BUTLER_ROW_PART]: ButlerRow,
    [BUTLER_RENAME]: RenameButlerDialog,
    [BUTLER_SET_UP]: ButlerSetUpDialog
  },
  fills: [
    fill(LANDING_AFTER_CLOSE, butlerLanding),
    fill(WORKSPACE_CLAIM, isButlersWorkspace),
    fill(GLOBAL_NOTE, useButlerShowsGlobalNote),
    fill(ROW_MARK, { at: 'sub', useMarkOf: useStartedByButler, Mark: StartedByButler }),
    fill(PALETTE_HAND_OFF, (request) => window.api.conductors.fromPalette(request))
  ]
}
