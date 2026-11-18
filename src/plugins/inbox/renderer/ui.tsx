import type { PluginUi } from '@core/ui'
import { INBOX_PAGE, INBOX_ROW } from '../plugin'
import { InboxPage, InboxRow } from './Inbox'

export const ui: PluginUi = { parts: { [INBOX_ROW]: InboxRow, [INBOX_PAGE]: InboxPage } }
