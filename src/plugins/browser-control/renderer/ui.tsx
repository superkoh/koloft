import type { PluginUi } from '@core/ui'
import { BROWSER_CONTROL_PAGE } from '../plugin'
import { BrowserControlSettings } from './BrowserControlSettings'

export const ui: PluginUi = {
  parts: { [BROWSER_CONTROL_PAGE]: BrowserControlSettings }
}
