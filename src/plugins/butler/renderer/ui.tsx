import { fill, type PluginUi } from '@core/ui'
import { GLOBAL_NOTE, LANDING_AFTER_CLOSE } from '@renderer/slots'
import { BUTLER_RENAME, BUTLER_ROW_PART, BUTLER_SET_UP } from '../plugin'
import { ButlerRow, RenameButlerDialog } from './ButlerRow'
import { ButlerSetUpDialog } from './SetUpDialog'
import { butlerLanding, useButlerShowsGlobalNote } from './landing'

export const ui: PluginUi = {
  parts: {
    [BUTLER_ROW_PART]: ButlerRow,
    [BUTLER_RENAME]: RenameButlerDialog,
    [BUTLER_SET_UP]: ButlerSetUpDialog
  },
  fills: [fill(LANDING_AFTER_CLOSE, butlerLanding), fill(GLOBAL_NOTE, useButlerShowsGlobalNote)]
}
