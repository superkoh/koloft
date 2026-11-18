import { fill, type PluginUi } from '@core/ui'
import { GLOBAL_NOTE, LANDING_AFTER_CLOSE, ROW_MARK } from '@renderer/slots'
import {
  BUTLER_FRESH,
  BUTLER_INSTRUCTIONS,
  BUTLER_RENAME,
  BUTLER_ROW_PART,
  BUTLER_SET_UP,
  BUTLER_STRIP
} from '../plugin'
import { ButlerRow, RenameButlerDialog } from './ButlerRow'
import { ButlerSetUpDialog } from './SetUpDialog'
import { FreshConversationDialog, InstructionsDialog, InstructionsStrip } from './InstructionsStrip'
import { butlerLanding, useButlerShowsGlobalNote } from './landing'
import { StartedByButler, useStartedByButler } from './startedBy'

export const ui: PluginUi = {
  parts: {
    [BUTLER_ROW_PART]: ButlerRow,
    [BUTLER_RENAME]: RenameButlerDialog,
    [BUTLER_SET_UP]: ButlerSetUpDialog,
    [BUTLER_STRIP]: InstructionsStrip,
    [BUTLER_INSTRUCTIONS]: InstructionsDialog,
    [BUTLER_FRESH]: FreshConversationDialog
  },
  fills: [
    fill(LANDING_AFTER_CLOSE, butlerLanding),
    fill(GLOBAL_NOTE, useButlerShowsGlobalNote),
    fill(ROW_MARK, { at: 'sub', useMarkOf: useStartedByButler, Mark: StartedByButler })
  ]
}
